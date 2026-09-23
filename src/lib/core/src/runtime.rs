//! Randomness and time, from the JavaScript host.
//!
//! Two of the deploy operation's seams are things a browser has but a wasm
//! module does not: a source of randomness, for picking one of the network's
//! default subnets, and a clock, for giving a freshly started canister a moment
//! before its sync plugin's first call. Both are a JavaScript call away.

use std::time::Duration;

use async_trait::async_trait;
use icp_project::{
    random::{Random, RandomError},
    timer::Timer,
};
use js_sys::{Function, Promise};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::host::assume_send;

/// A choice made by `Math.random()`. Which of a network's default subnets a
/// deployment lands on is a matter of spreading load, not of security, so the
/// engine behind the page's own randomness is the right one.
pub struct JsRandom;

#[async_trait]
impl Random for JsRandom {
    async fn index_below(&self, count: usize) -> Result<Option<usize>, RandomError> {
        Ok((count > 0).then(|| {
            // `Math.random()` is in `[0, 1)`, so the product is below `count`;
            // the clamp only guards the rounding of a very large count.
            ((js_sys::Math::random() * count as f64) as usize).min(count - 1)
        }))
    }
}

#[wasm_bindgen]
extern "C" {
    /// The host's `setTimeout`, a global in a browser and in Node alike.
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(handler: &Function, milliseconds: i32) -> JsValue;
}

/// A wait on the host's event loop. There is no clock inside the module — the
/// standard library has none on this target — so time passes where the page's
/// does.
pub struct JsTimer;

#[async_trait]
impl Timer for JsTimer {
    async fn sleep(&self, duration: Duration) {
        assume_send(sleep(duration)).await;
    }
}

async fn sleep(duration: Duration) {
    let milliseconds = i32::try_from(duration.as_millis()).unwrap_or(i32::MAX);
    let settled = Promise::new(&mut |resolve, _reject| {
        set_timeout(&resolve, milliseconds);
    });
    // A timer promise only ever resolves.
    let _ = JsFuture::from(settled).await;
}
