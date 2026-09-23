/**
 * The deployer UI: pick a bundle, sign in, deploy.
 *
 * The DOM skeleton is built once and its regions are updated in place, so the file
 * input and drop target keep their identity across renders.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import {
  createDeployer,
  cyclesBalance,
  formatBytes,
  loadBundle,
  formatCycles,
  supportsJspi,
  type Bundle,
  type DeployEvent,
  type DeployResult,
} from '../lib'
import { restoreSession, signInWithInternetIdentity, signOut, useTemporaryIdentity, type Session } from './auth'
import { createAgent, describeNetwork, type Network } from './network'
import { planUpgrade, readStatuses, type UpgradePlan } from './plan'
import { deployRecorded, proposeApplicationName, upgradeRecorded } from './recording'
import { createRegistry, isValidApplicationName, RegistryError, type Application } from './registry'

interface State {
  network: Network
  session?: Session
  agent?: HttpAgent
  balance?: bigint
  bundle?: Bundle
  bundleError?: string
  /** The signed-in principal's applications; `undefined` while they load. */
  applications?: Application[]
  applicationsError?: string
  busy: boolean
  result?: DeployResult
  /** The application the last result was recorded under. */
  resultApplication?: string
  /** The application being upgraded, while the drop panel is bound to one. */
  upgrading?: Application
  /** What the dropped bundle will do to the application being upgraded. */
  plan?: UpgradePlan
  planError?: string
}

const SKELETON = `
  <header class="header">
    <h1>Bundle deployer</h1>
    <p class="subtitle">
      Deploy an application bundle to the Internet Computer — entirely from this page.
    </p>
  </header>

  <section class="panel" id="identity-panel"></section>

  <section class="panel" id="applications-panel" hidden></section>

  <section class="panel">
    <p class="banner" id="upgrade-banner" hidden>
      Upgrading <strong id="upgrade-name"></strong>: drop the new version of its bundle.
      <a href="#" id="cancel-upgrade">Cancel</a>
    </p>
    <div class="dropzone" id="dropzone" tabindex="0" role="button">
      <strong>Drop an application bundle here</strong>
      <span class="hint">or click to choose a <code>.icp</code> file</span>
      <input type="file" id="file-input" accept=".icp,.tar,.tar.gz,.tgz" hidden />
    </div>
    <div id="bundle-panel"></div>
  </section>

  <section class="panel">
    <label class="field" for="application-name">
      <span>Application name</span>
      <input type="text" id="application-name" spellcheck="false" autocomplete="off"
             maxlength="64" placeholder="what to list this deployment as" />
      <span class="hint">Proposed from the bundle's file name; 1 to 64 characters. The
        name is how the application is listed and found again to upgrade it.</span>
    </label>
    <label class="field" for="subnet">
      <span>Target subnet <span class="muted">— optional</span></span>
      <input type="text" id="subnet" spellcheck="false" autocomplete="off"
             placeholder="leave empty to let the network choose" />
      <span class="hint">Pins every canister to one subnet. A cloud engine is a single
        subnet; its id is on the engine console's Applications page.</span>
    </label>
    <button id="deploy" class="primary" disabled>Deploy</button>
    <ol class="log" id="log"></ol>
    <div id="result"></div>
  </section>
`

export function mountApp(root: HTMLElement, network: Network): void {
  root.innerHTML = SKELETON

  const state: State = { network, busy: false }

  const identityPanel = select<HTMLElement>(root, '#identity-panel')
  const applicationsPanel = select<HTMLElement>(root, '#applications-panel')
  const bundlePanel = select<HTMLElement>(root, '#bundle-panel')
  const resultPanel = select<HTMLElement>(root, '#result')
  const dropzone = select<HTMLElement>(root, '#dropzone')
  const fileInput = select<HTMLInputElement>(root, '#file-input')
  const deployButton = select<HTMLButtonElement>(root, '#deploy')
  const subnetInput = select<HTMLInputElement>(root, '#subnet')
  const nameInput = select<HTMLInputElement>(root, '#application-name')
  const nameField = nameInput.closest<HTMLElement>('.field')!
  const subnetField = subnetInput.closest<HTMLElement>('.field')!
  const upgradeBanner = select<HTMLElement>(root, '#upgrade-banner')
  const upgradeName = select<HTMLElement>(root, '#upgrade-name')
  const log = select<HTMLOListElement>(root, '#log')

  function renderIdentity(): void {
    const { network, session, balance } = state
    const rows = [row('Network', escapeHtml(describeNetwork(network)))]

    if (session) {
      rows.push(
        row('Identity', `<code>${escapeHtml(session.principal.toText())}</code>`),
        row(
          'Signed in with',
          session.source === 'internet-identity' ? 'Internet Identity' : 'a temporary browser key',
        ),
      )
      // Creation is paid for from the cycles ledger on every network, so the balance
      // matters everywhere — not just on mainnet.
      rows.push(row('Cycles', balance === undefined ? 'checking…' : escapeHtml(formatCycles(balance))))
    }

    const actions = session
      ? `<button id="sign-out">Sign out</button>`
      : `<button id="sign-in" class="primary">Sign in with Internet Identity</button>` +
        (network.kind === 'mainnet'
          ? ''
          : `<button id="use-temporary">Use a temporary identity</button>`)

    identityPanel.innerHTML = `<dl class="facts">${rows.join('')}</dl><div class="actions">${actions}</div>`

    identityPanel.querySelector('#sign-in')?.addEventListener('click', () => {
      void withBusy(async () => establish(await signInWithInternetIdentity()))
    })
    identityPanel.querySelector('#use-temporary')?.addEventListener('click', () => {
      void withBusy(async () => establish(useTemporaryIdentity()))
    })
    identityPanel.querySelector('#sign-out')?.addEventListener('click', () => {
      void withBusy(async () => {
        await signOut()
        state.session = undefined
        state.agent = undefined
        state.balance = undefined
        state.applications = undefined
        state.applicationsError = undefined
        renderIdentity()
        renderApplications()
        renderDeployButton()
      })
    })
  }

  async function establish(session: Session): Promise<void> {
    state.session = session
    state.agent = await createAgent(state.network, session.identity)
    state.balance = undefined
    state.applications = undefined
    state.applicationsError = undefined
    renderIdentity()
    renderApplications()
    renderDeployButton()

    // Both informational — a failure here must not block deploying.
    const agent = state.agent
    await Promise.all([
      cyclesBalance(agent, session.principal)
        .catch(() => 0n)
        .then((balance) => {
          if (state.agent === agent) state.balance = balance
          renderIdentity()
        }),
      loadApplications(agent),
    ])
  }

  /** The signed-in principal's applications, read from the registry. */
  async function loadApplications(agent: HttpAgent): Promise<void> {
    const { registry } = state.network
    if (!registry) return
    try {
      const applications = await createRegistry(agent, registry).list()
      // Signing out or switching principal mid-flight makes this list somebody
      // else's; only the agent it was read with may show it.
      if (state.agent === agent) state.applications = applications
    } catch (error) {
      if (state.agent === agent) {
        state.applicationsError = error instanceof Error ? error.message : String(error)
      }
    }
    renderApplications()
  }

  function renderApplications(): void {
    const { session, network, applications, applicationsError } = state
    applicationsPanel.hidden = !session
    if (!session) {
      applicationsPanel.innerHTML = ''
      return
    }

    let body: string
    if (!network.registry) {
      body = `<p class="muted">This page was served without a registry canister, so the
        applications deployed with it cannot be listed.</p>`
    } else if (applicationsError) {
      body = `<p class="error">Could not read your applications: ${escapeHtml(applicationsError)}</p>`
    } else if (!applications) {
      body = `<p class="muted">Loading…</p>`
    } else if (applications.length === 0) {
      body = `<p class="muted">No applications yet. Drop a bundle below to install one.</p>`
    } else {
      body = `<ul class="applications">${applications.map(renderApplication).join('')}</ul>`
    }
    applicationsPanel.innerHTML = `<h2>Applications</h2>${body}`
  }

  function renderApplication(application: Application): string {
    const rows = application.canisters
      .map(
        (canister) => `
        <tr>
          <td><strong>${escapeHtml(canister.name)}</strong>${
            canister.state === 'deployed'
              ? ''
              : ` <span class="badge warn">${escapeHtml(canister.state)}</span>`
          }</td>
          <td><code>${escapeHtml(canister.canisterId.toText())}</code></td>
        </tr>`,
      )
      .join('')
    const canisters =
      application.canisters.length === 0
        ? `<p class="muted">No canisters were created for this application.</p>`
        : `<table class="canisters">
            <thead><tr><th>Canister</th><th>Id</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`

    return `
      <li>
        <details class="application">
          <summary>
            <strong>${escapeHtml(application.name)}</strong>
            <span class="muted">last deployed ${escapeHtml(application.updated.toLocaleString())}</span>
          </summary>
          <p class="muted">From <code>${escapeHtml(application.bundleFileName)}</code>,
            first deployed ${escapeHtml(application.created.toLocaleString())}.</p>
          ${canisters}
          <div class="actions">
            <button class="upgrade" data-application="${escapeHtml(application.name)}">Upgrade</button>
          </div>
        </details>
      </li>`
  }

  /** Binds the drop panel to an application: its next bundle upgrades it. */
  function startUpgrade(application: Application): void {
    state.upgrading = application
    state.plan = undefined
    state.planError = undefined
    state.bundle?.dispose()
    state.bundle = undefined
    state.bundleError = undefined
    state.result = undefined
    state.resultApplication = undefined
    log.replaceChildren()
    renderUpgradeMode()
    renderBundle()
    renderResult()
    renderDeployButton()
    dropzone.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function cancelUpgrade(): void {
    state.upgrading = undefined
    state.plan = undefined
    state.planError = undefined
    renderUpgradeMode()
    renderBundle()
    renderDeployButton()
  }

  /**
   * In upgrade mode the name is the application's and the subnet is decided
   * by the canisters that already exist, so neither field applies.
   */
  function renderUpgradeMode(): void {
    const upgrading = state.upgrading
    upgradeBanner.hidden = !upgrading
    upgradeName.textContent = upgrading?.name ?? ''
    nameField.hidden = Boolean(upgrading)
    subnetField.hidden = Boolean(upgrading)
  }

  /**
   * The pre-flight: read every recorded canister's status, then say what the
   * dropped bundle will do to each. Nothing is created here.
   */
  async function planFor(bundle: Bundle, application: Application): Promise<void> {
    const { agent } = state
    if (!agent) return
    try {
      const statuses = await readStatuses(agent, application)
      // The bundle may have been replaced or the upgrade cancelled meanwhile.
      if (state.bundle !== bundle || state.upgrading !== application) return
      state.plan = planUpgrade(application, bundle, statuses)
    } catch (error) {
      if (state.bundle !== bundle) return
      state.planError = error instanceof Error ? error.message : String(error)
    }
    renderBundle()
    renderDeployButton()
  }

  function renderPlan(plan: UpgradePlan, application: Application): string {
    const badge = (text: string, kind = '') => `<span class="badge ${kind}">${escapeHtml(text)}</span>`
    const rows = [
      ...plan.canisters.map(
        (canister) => `
        <tr>
          <td><strong>${escapeHtml(canister.name)}</strong></td>
          <td>${badge(canister.action, canister.action === 'create' ? 'ok' : '')}</td>
          <td>${canister.canisterId ? `<code>${escapeHtml(canister.canisterId.toText())}</code>` : '<span class="muted">new</span>'}</td>
        </tr>`,
      ),
      ...plan.orphaned.map(
        (canister) => `
        <tr>
          <td><strong>${escapeHtml(canister.name)}</strong></td>
          <td>${badge('orphaned', 'warn')}</td>
          <td><code>${escapeHtml(canister.canisterId.toText())}</code> <span class="muted">— no longer in the bundle; left alone</span></td>
        </tr>`,
      ),
    ].join('')

    const blocked =
      plan.blocked.length === 0
        ? ''
        : `<p class="error">The upgrade cannot go ahead: ${plan.blocked
            .map((canister) => `${escapeHtml(canister.name)} (${escapeHtml(canister.canisterId.toText())}) — ${escapeHtml(canister.reason)}`)
            .join('; ')}. Nothing was created.</p>`

    return `
      <p class="loaded">Upgrading <strong>${escapeHtml(application.name)}</strong> with
        <strong>${escapeHtml(state.bundle?.fileName ?? 'bundle')}</strong>:</p>
      <table class="canisters">
        <thead><tr><th>Canister</th><th>Action</th><th>Id</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${blocked}`
  }

  function renderBundle(): void {
    if (state.bundleError) {
      bundlePanel.innerHTML = `<p class="error">${escapeHtml(state.bundleError)}</p>`
      return
    }
    if (!state.bundle) {
      bundlePanel.innerHTML = ''
      return
    }

    if (state.upgrading) {
      if (state.planError) {
        bundlePanel.innerHTML = `<p class="error">${escapeHtml(state.planError)}</p>`
      } else if (!state.plan) {
        bundlePanel.innerHTML = `<p class="muted">Checking the application's canisters…</p>`
      } else {
        bundlePanel.innerHTML = renderPlan(state.plan, state.upgrading)
      }
      return
    }

    const { fileName, canisters } = state.bundle
    const rows = canisters
      .map(
        (canister) => `
        <tr>
          <td><strong>${escapeHtml(canister.name)}</strong></td>
          <td><code>${escapeHtml(canister.wasmPath)}</code></td>
          <td>${escapeHtml(formatBytes(canister.wasmSize))}</td>
          <td>${
            canister.syncDirs.length === 0
              ? '<span class="muted">—</span>'
              : canister.syncDirs
                  .map((dir) => `<code>${escapeHtml(dir)}</code>`)
                  .join('<br />')
          }</td>
          <td class="digest">${
            canister.sha256
              ? '<span class="ok">sha256 verified</span>'
              : `<span class="warn">no digest declared</span><br /><code>${escapeHtml(
                  canister.digest,
                )}</code>`
          }</td>
        </tr>`,
      )
      .join('')

    // A plugin cannot wait for a canister call without JSPI, so say so before the
    // user starts a deployment that would stop halfway.
    const needsSync = canisters.some((canister) => canister.syncDirs.length > 0)
    const warning =
      needsSync && !supportsJspi()
        ? `<p class="warn">This bundle syncs assets, which needs WebAssembly JSPI — available
           in Chrome 137+ and Edge, and behind a flag in Firefox. Canisters would be created
           and their wasm installed, but the sync would fail.</p>`
        : ''

    bundlePanel.innerHTML = `
      <p class="loaded">Loaded <strong>${escapeHtml(fileName ?? 'bundle')}</strong> — ${
        canisters.length
      } canister${canisters.length === 1 ? '' : 's'}.</p>
      <table class="canisters">
        <thead><tr><th>Canister</th><th>Wasm</th><th>Size</th><th>Syncs</th><th>Integrity</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${warning}`
  }

  function renderDeployButton(): void {
    const name = nameInput.value
    const validName = isValidApplicationName(name)
    nameInput.classList.toggle('invalid', name !== '' && !validName)
    const ready = state.upgrading
      ? state.plan !== undefined && state.plan.blocked.length === 0
      : validName
    deployButton.disabled = state.busy || !state.bundle || !state.agent || !ready
    deployButton.textContent = state.busy ? 'Working…' : state.upgrading ? 'Confirm upgrade' : 'Deploy'
  }

  function renderResult(): void {
    const { result, resultApplication, network } = state
    if (!result) {
      resultPanel.innerHTML = ''
      return
    }

    const sections: string[] = []
    if (resultApplication) {
      sections.push(
        `<p class="loaded">Recorded as application <strong>${escapeHtml(resultApplication)}</strong>.</p>`,
      )
    }
    if (result.deployed.length > 0) {
      sections.push(
        `<h2>Deployed</h2><ul class="deployed">${result.deployed
          .map(
            ({ name, canisterId }) =>
              `<li><strong>${escapeHtml(name)}</strong> <code>${escapeHtml(canisterId.toText())}</code>${
                network.kind === 'mainnet'
                  ? ` <a href="https://dashboard.internetcomputer.org/canister/${escapeHtml(
                      canisterId.toText(),
                    )}" target="_blank" rel="noreferrer">dashboard</a>`
                  : ''
              }</li>`,
          )
          .join('')}</ul>`,
      )
    }
    if (result.incomplete.length > 0) {
      sections.push(
        `<p class="warn">Created but not finished: ${result.incomplete
          .map(({ name, canisterId }) => `${escapeHtml(name)} (${escapeHtml(canisterId.toText())})`)
          .join(', ')}. They exist and are controlled by you.</p>`,
      )
    }
    if (result.error) {
      sections.push(`<p class="error">${escapeHtml(result.error)}</p>`)
    }
    resultPanel.innerHTML = sections.join('')
  }

  function appendLog(message: string, kind: 'info' | 'error' | 'done' = 'info'): void {
    const line = document.createElement('li')
    line.className = kind
    line.textContent = message
    log.append(line)
    line.scrollIntoView({ block: 'nearest' })
  }

  async function withBusy(action: () => Promise<void>): Promise<void> {
    state.busy = true
    renderDeployButton()
    try {
      await action()
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      state.busy = false
      renderDeployButton()
    }
  }

  async function openBundle(file: File): Promise<void> {
    // The outgoing bundle holds a whole uncompressed archive on the module's
    // heap, and its JavaScript wrapper is too small for the collector to feel.
    state.bundle?.dispose()
    state.bundle = undefined
    state.bundleError = undefined
    state.result = undefined
    state.resultApplication = undefined
    log.replaceChildren()
    renderResult()

    try {
      state.bundle = await loadBundle(file)
    } catch (error) {
      state.bundleError = error instanceof Error ? error.message : String(error)
    }
    // The file name is the best guess at what the application is called; the
    // user can still say otherwise.
    nameInput.value = proposeApplicationName(state.bundle?.fileName)
    state.plan = undefined
    state.planError = undefined
    renderBundle()
    renderDeployButton()
    if (state.bundle && state.upgrading) void planFor(state.bundle, state.upgrading)
  }

  function onDeployEvent(event: DeployEvent): void {
    switch (event.type) {
      case 'phase':
        appendLog(event.message)
        break
      case 'started':
        if (event.action === 'create') appendLog(`${event.name}: creating canister…`)
        else if (event.action === 'upgrade') appendLog(`Upgrading ${event.name} (${event.canisterId?.toText()})`)
        else appendLog(`Installing into the empty canister ${event.name} (${event.canisterId?.toText()})`)
        break
      case 'created':
        appendLog(`${event.name}: created ${event.canisterId.toText()}`)
        break
      case 'progress':
        appendLog(`${event.name}: ${event.message}`)
        break
      case 'installed':
        appendLog(`${event.name}: ${event.action === 'upgrade' ? 'upgraded' : 'installed'}`, 'done')
        break
      case 'failed':
        appendLog(event.message, 'error')
        break
    }
  }

  dropzone.addEventListener('click', () => fileInput.click())
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      fileInput.click()
    }
  })
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault()
    dropzone.classList.add('over')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'))
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropzone.classList.remove('over')
    const file = event.dataTransfer?.files?.[0]
    if (file) void openBundle(file)
  })
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void openBundle(file)
  })

  nameInput.addEventListener('input', renderDeployButton)
  applicationsPanel.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.upgrade')
    if (!button || state.busy) return
    const application = state.applications?.find((a) => a.name === button.dataset.application)
    if (application) startUpgrade(application)
  })
  select<HTMLAnchorElement>(root, '#cancel-upgrade').addEventListener('click', (event) => {
    event.preventDefault()
    if (!state.busy) cancelUpgrade()
  })

  deployButton.addEventListener('click', () => {
    const { bundle, agent, session, network, upgrading, plan } = state
    if (!bundle || !agent || !session) return

    const name = upgrading ? upgrading.name : nameInput.value
    if (!upgrading && !isValidApplicationName(name)) return
    if (upgrading && (!plan || plan.blocked.length > 0)) return
    if (!network.registry) {
      log.replaceChildren()
      appendLog(
        'This page was served without a registry canister, so the deployment could not be ' +
          'recorded as an application. Open the page through its canister URL.',
        'error',
      )
      return
    }
    const registry = createRegistry(agent, network.registry)

    let subnet: Principal | undefined
    const entered = subnetInput.value.trim()
    if (entered !== '') {
      try {
        subnet = Principal.fromText(entered)
      } catch {
        log.replaceChildren()
        appendLog(`"${entered}" is not a valid subnet id.`, 'error')
        return
      }
    }

    void withBusy(async () => {
      log.replaceChildren()
      const deployer = createDeployer({ agent })

      // The name is reserved before anything is deployed, so a clash is the
      // first and only thing that happens; the hint says the existing
      // application can be upgraded instead.
      let recorded
      try {
        if (upgrading && plan) {
          // The canisters the plan reuses are handed to the deployer, which
          // upgrades or installs into them and creates the rest beside them.
          recorded = await upgradeRecorded({
            registry,
            record: upgrading,
            bundle: { sha256: bundle.sha256, fileName: bundle.fileName ?? '' },
            plan,
            deploy: (record) =>
              deployer.deploy(bundle, {
                existing: plan.existing,
                onEvent: (event) => {
                  record(event)
                  onDeployEvent(event)
                },
              }),
          })
          cancelUpgrade()
        } else {
          recorded = await deployRecorded({
            registry,
            application: { name, bundleSha256: bundle.sha256, bundleFileName: bundle.fileName ?? '' },
            deploy: (record) =>
              deployer.deploy(bundle, {
                subnet,
                onEvent: (event) => {
                  record(event)
                  onDeployEvent(event)
                },
              }),
          })
        }
      } catch (error) {
        if (error instanceof RegistryError) {
          appendLog(error.message, 'error')
          return
        }
        throw error
      }

      state.result = recorded.result
      state.resultApplication = name
      if (recorded.recordingError) {
        appendLog(
          `The application record could not be brought up to date: ${recorded.recordingError}`,
          'error',
        )
      } else {
        appendLog(`Recorded as application "${name}".`, 'done')
      }
      renderResult()
      void loadApplications(agent)
    })
  })

  renderIdentity()
  renderApplications()
  renderDeployButton()

  void restoreSession().then(async (session) => {
    if (session) await establish(session)
  })
}

function select<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`Missing element ${selector}`)
  return element
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
}

function row(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
}
