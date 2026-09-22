//! Recipes, as far as a bundle can honour them.
//!
//! A manifest may define a canister by recipe rather than by explicit build and
//! sync steps, and `icp-project` retrieves the template through [`Resolve`] —
//! a seam, because doing so may mean an HTTP request. Nothing in a bundle is
//! fetched, so this is the resolver that serves only what the archive already
//! holds, a template written beside the manifest, and refuses anything that
//! would have to come from a URL or a registry. A bundle written by
//! `icp project bundle` has its recipes resolved into steps already, so mostly
//! this is a guarantee: whatever a manifest asks for, no network is reached
//! before a deployment starts.

use async_trait::async_trait;
use icp_project::{
    canister::recipe::{Fetched, Resolve, ResolveError},
    files::FileSystem,
    manifest::recipe::{Recipe, RecipeType},
    prelude::*,
};
use snafu::Snafu;

use crate::files::BundleFiles;

/// Serves recipe templates out of the bundle, and nothing that would have to be
/// fetched.
pub struct LocalRecipes(pub BundleFiles);

#[derive(Debug, Snafu)]
#[snafu(display(
    "recipe '{recipe}' would have to be fetched, and a bundle must carry everything it needs"
))]
pub struct RemoteRecipeError {
    recipe: String,
}

#[async_trait]
impl Resolve for LocalRecipes {
    async fn resolve(&self, recipe: &Recipe) -> Result<Fetched, ResolveError> {
        match &recipe.recipe_type {
            RecipeType::File(path) => {
                let template = self
                    .0
                    .read_to_string(Path::new(path))
                    .await
                    .map_err(ResolveError::new)?;
                // Read out of memory, so there is nothing to hold back until the
                // template is known to render.
                Ok(Fetched {
                    template,
                    deferred: false,
                })
            }
            remote => Err(ResolveError::new(RemoteRecipeError {
                recipe: remote.to_string(),
            })),
        }
    }
}
