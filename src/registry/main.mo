/// The application registry: what each user has deployed with the page.
///
/// One canister per network, deployed beside the frontend and found by it
/// through `PUBLIC_CANISTER_ID:registry` in the certified `ic_env` cookie, the
/// same way the deployer's own canisters find each other. State persists
/// across upgrades through enhanced orthogonal persistence.

import Map "mo:core/Map";
import Api "mixins/Api";
import Types "types";

actor {
  let applications : Types.State = Map.empty();
  include Api(applications);
};
