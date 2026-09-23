//! The deploy operation's progress, as this library reports it.
//!
//! `icp_project::operations::deploy` reports on a stream of task events: a
//! heading task per phase, a task per canister per phase nested under it, and
//! the lines a step prints under that. It is the stream icp-cli's terminal
//! renderer draws from, and it says everything a caller could want — which is
//! more than the page shows. What comes out here is the smaller vocabulary of
//! [`DeployEvent`]: a phase, a canister being started, created, installed, a
//! line of progress, a failure.
//!
//! The same stream is what decides the result. Whether a canister counts as
//! deployed when the run fails part-way is a question of which of its tasks
//! succeeded, and that is read off the outcomes here rather than reconstructed
//! from the error.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};

use icp_events::{EventKind, TaskId, TaskOutcome};
use icp_project::operations::task::{Event, Task};

use crate::events::DeployEvent;

/// Where translated events go.
pub type Sink = Arc<dyn Fn(DeployEvent) + Send + Sync>;

/// Which canisters got how far. A canister's install and sync tasks are the
/// ones whose success means something is finished; the phases before them
/// configure a canister that is not yet running anything.
#[derive(Debug, Default)]
pub struct Outcomes {
    pub installed: BTreeSet<String>,
    pub synced: BTreeSet<String>,
}

/// Turns the operation's events into this library's, one at a time.
pub struct Translator {
    sink: Sink,
    /// The size of each canister's module, for saying how much is about to be
    /// installed and whether it goes up through the chunk store.
    wasm_sizes: BTreeMap<String, usize>,
    /// The tasks still running, so a line or an outcome can be attributed to
    /// the canister its task is about.
    tasks: HashMap<TaskId, Task>,
    outcomes: Outcomes,
}

impl Translator {
    pub fn new(sink: Sink, wasm_sizes: BTreeMap<String, usize>) -> Self {
        Self {
            sink,
            wasm_sizes,
            tasks: HashMap::new(),
            outcomes: Outcomes::default(),
        }
    }

    pub fn outcomes(&self) -> &Outcomes {
        &self.outcomes
    }

    fn emit(&self, event: DeployEvent) {
        (self.sink)(event);
    }

    pub fn handle(&mut self, event: Event) {
        match event.kind {
            EventKind::TaskStarted { task, .. } => {
                self.started(&task);
                self.tasks.insert(event.task_id, task);
            }
            // A plugin's output, as it prints it. The build phase prints too —
            // which module it is copying — but a bundle's build is not
            // something the user is waiting on.
            EventKind::Output { line, .. } => {
                if let Some(Task::Sync(sync)) = self.tasks.get(&event.task_id) {
                    self.emit(DeployEvent::Progress {
                        name: sync.canister.clone(),
                        message: line,
                    });
                }
            }
            EventKind::TaskCompleted { outcome } => {
                if let Some(task) = self.tasks.remove(&event.task_id) {
                    self.completed(task, outcome);
                }
            }
            // Steps and byte counts are finer than the page shows.
            EventKind::StepStarted { .. }
            | EventKind::StepCompleted { .. }
            | EventKind::CommandStarted { .. }
            | EventKind::Progress { .. } => {}
        }
    }

    fn started(&self, task: &Task) {
        match task {
            // The build phase is skipped: nothing is built out of a bundle, and
            // a heading saying so would have the user wondering what is.
            Task::Phase(phase) if is_build_phase(&phase.title) => {}
            Task::Phase(phase) => self.emit(DeployEvent::Phase {
                message: phase.title.trim_end_matches(':').to_owned(),
            }),
            Task::Create(create) => self.emit(DeployEvent::Started {
                name: create.canister.clone(),
            }),
            Task::Install(install) => self.emit(DeployEvent::Progress {
                name: install.canister.clone(),
                message: installing(self.wasm_sizes.get(&install.canister).copied()),
            }),
            // A plugin's output is otherwise the first sign its canister is being
            // synced, arriving under a name the log last reported as installed.
            Task::Sync(sync) => self.emit(DeployEvent::Progress {
                name: sync.canister.clone(),
                message: "Running the sync steps the manifest declares…".to_owned(),
            }),
            Task::Build(_)
            | Task::UpdateSettings(_)
            | Task::UpdateEnvironmentVariables(_)
            | Task::CandidCheck(_)
            | Task::SnapshotTransfer(_) => {}
        }
    }

    fn completed(&mut self, task: Task, outcome: TaskOutcome) {
        match outcome {
            TaskOutcome::Succeeded { retained_output } => match task {
                Task::Install(install) => {
                    self.outcomes.installed.insert(install.canister.clone());
                    self.emit(DeployEvent::Installed {
                        name: install.canister,
                        canister_id: install.canister_id.to_text(),
                    });
                }
                Task::Sync(sync) => {
                    self.outcomes.synced.insert(sync.canister.clone());
                    // Lines a step asked to have kept after it succeeded; a
                    // plugin run here streams everything as it goes, so this is
                    // usually empty.
                    for line in retained_output {
                        self.emit(DeployEvent::Progress {
                            name: sync.canister.clone(),
                            message: line,
                        });
                    }
                }
                _ => {}
            },
            // A phase carries no failure of its own: whichever child failed has
            // already said so, and the error itself is on the return path.
            TaskOutcome::Failed { message, causes } => {
                if let Some(name) = task.presentation().canister() {
                    self.emit(DeployEvent::Failed {
                        name: name.to_owned(),
                        message: describe_failure(&task, &message, &causes),
                    });
                }
            }
            TaskOutcome::Skipped { .. } => {}
        }
    }
}

/// The deploy operation's first phase, whose heading a bundle has no use for.
fn is_build_phase(title: &str) -> bool {
    title.starts_with("Building")
}

/// What is about to be installed, and how. A wasm over the ingress limit goes up
/// through the chunk store, which is worth saying because it takes noticeably
/// longer.
fn installing(wasm_size: Option<usize>) -> String {
    const CHUNK_THRESHOLD: usize = 2 * 1024 * 1024;

    let Some(wasm_size) = wasm_size else {
        return "Installing…".to_owned();
    };
    let size = crate::format_bytes(wasm_size);
    if wasm_size > CHUNK_THRESHOLD {
        format!("Installing {size} through the chunk store…")
    } else {
        format!("Installing {size}…")
    }
}

/// A failure as the page shows it: what was being done to which canister, then
/// the operation's own message and the chain of causes behind it.
fn describe_failure(task: &Task, message: &str, causes: &[String]) -> String {
    let what = match task {
        Task::Build(build) => format!(
            "Could not read the module of canister \"{}\"",
            build.canister
        ),
        Task::Create(create) => format!("Could not create canister \"{}\"", create.canister),
        Task::Install(install) => format!(
            "Could not install canister \"{}\" ({})",
            install.canister, install.canister_id
        ),
        Task::Sync(sync) => format!(
            "Could not sync canister \"{}\" ({})",
            sync.canister, sync.canister_id
        ),
        Task::UpdateSettings(settings) => format!(
            "Could not configure canister \"{}\" ({})",
            settings.canister, settings.canister_id
        ),
        Task::UpdateEnvironmentVariables(variables) => format!(
            "Could not set the environment variables of canister \"{}\" ({})",
            variables.canister, variables.canister_id
        ),
        Task::CandidCheck(check) => format!(
            "Canister \"{}\" ({}) would break its interface",
            check.canister, check.canister_id
        ),
        Task::SnapshotTransfer(transfer) => {
            format!(
                "Could not transfer a snapshot of canister \"{}\"",
                transfer.canister
            )
        }
        Task::Phase(phase) => phase.title.clone(),
    };
    let mut text = format!("{what}: {message}");
    for cause in causes {
        text.push_str(": ");
        text.push_str(cause);
    }
    text
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use candid::Principal;
    use icp_events::channel;
    use icp_project::operations::task::Reporter;

    use super::*;

    fn cid() -> Principal {
        Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap()
    }

    /// Drives `f` against a fresh reporter and returns what the translator made
    /// of everything it reported, plus the translator for its outcomes.
    fn translate(f: impl FnOnce(&Reporter)) -> (Vec<DeployEvent>, Translator) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink: Sink = Arc::new({
            let seen = Arc::clone(&seen);
            move |event| seen.lock().unwrap().push(event)
        });
        let mut translator =
            Translator::new(sink, BTreeMap::from([("site".to_owned(), 3 * 1024 * 1024)]));
        let (reporter, mut rx) = channel::<Task>();
        f(&reporter);
        drop(reporter);
        while let Ok(event) = rx.try_recv() {
            translator.handle(event);
        }
        let events = seen.lock().unwrap().clone();
        (events, translator)
    }

    #[test]
    fn phases_become_headings_except_the_build() {
        let (events, _) = translate(|reporter| {
            reporter
                .task(Task::phase("Building canisters:"))
                .finish(TaskOutcome::succeeded());
            reporter
                .task(Task::phase("Creating canisters:"))
                .finish(TaskOutcome::succeeded());
        });
        assert_eq!(
            events,
            vec![DeployEvent::Phase {
                message: "Creating canisters".to_owned()
            }]
        );
    }

    #[test]
    fn an_install_reports_its_size_and_then_its_canister() {
        let (events, translator) = translate(|reporter| {
            reporter
                .task(Task::install("site", cid()))
                .finish(TaskOutcome::succeeded());
        });
        assert_eq!(
            events,
            vec![
                DeployEvent::Progress {
                    name: "site".to_owned(),
                    message: "Installing 3.0 MiB through the chunk store…".to_owned(),
                },
                DeployEvent::Installed {
                    name: "site".to_owned(),
                    canister_id: cid().to_text(),
                },
            ]
        );
        assert!(translator.outcomes().installed.contains("site"));
    }

    /// A plugin's lines arrive under the canister whose sync task they belong
    /// to, and a build step's lines do not arrive at all.
    #[test]
    fn plugin_output_is_attributed_and_build_output_is_not() {
        let (events, translator) = translate(|reporter| {
            let build = reporter.task(Task::build("site"));
            build.step(1, 1, "pre-built").stdout("Writing WASM file");
            build.finish(TaskOutcome::succeeded());

            let sync = reporter.task(Task::sync("site", cid()));
            sync.step(1, 1, "plugin").stdout("uploaded 3 files");
            sync.finish(TaskOutcome::succeeded());
        });
        assert_eq!(
            events,
            vec![
                DeployEvent::Progress {
                    name: "site".to_owned(),
                    message: "Running the sync steps the manifest declares…".to_owned(),
                },
                DeployEvent::Progress {
                    name: "site".to_owned(),
                    message: "uploaded 3 files".to_owned(),
                },
            ]
        );
        assert!(translator.outcomes().synced.contains("site"));
    }

    /// A failed task names its canister and what was being done to it; a
    /// failed phase says nothing, because its child already did.
    #[test]
    fn failures_are_attributed_to_a_canister() {
        let (events, _) = translate(|reporter| {
            let phase = reporter.task(Task::phase("Creating canisters:"));
            let create = phase.reporter().task(Task::create("site"));
            create.finish(TaskOutcome::Failed {
                message: "failed to create canister".to_owned(),
                causes: vec!["insufficient funds".to_owned()],
            });
            phase.finish(TaskOutcome::failed("Canister(s) failed"));
        });
        assert_eq!(
            events,
            vec![
                DeployEvent::Phase {
                    message: "Creating canisters".to_owned()
                },
                DeployEvent::Started {
                    name: "site".to_owned()
                },
                DeployEvent::Failed {
                    name: "site".to_owned(),
                    message: "Could not create canister \"site\": failed to create canister: \
                              insufficient funds"
                        .to_owned(),
                },
            ]
        );
    }
}
