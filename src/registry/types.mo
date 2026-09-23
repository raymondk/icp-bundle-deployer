/// What the registry records: an application a user deployed with the page,
/// and the canisters it consists of.
///
/// Records are scoped to the principal that wrote them and carry no network:
/// the registry is deployed on one network and answers for that network only.

import Map "mo:core/Map";

module {
  /// What the deployment left a canister as. `unfinished` is created but not
  /// fully deployed; `orphaned` is recorded under the application but no
  /// longer named by its bundle. Both are left alone, never deleted.
  public type CanisterState = { #unfinished; #deployed; #orphaned };

  public type CanisterEntry = {
    /// The manifest name: the key the deployer files the canister under and
    /// injects as `PUBLIC_CANISTER_ID:<name>`. In a workspace bundle a
    /// dependency's canister is keyed by where it sits, e.g. `vendor/lib:backend`.
    name : Text;
    canisterId : Principal;
    state : CanisterState;
  };

  /// What a caller sends. The timestamps are the registry's to set.
  public type ApplicationInput = {
    /// Trimmed, 1 to 64 printable characters.
    name : Text;
    /// The identity of the bundle last deployed.
    bundleSha256 : Text;
    bundleFileName : Text;
    canisters : [CanisterEntry];
  };

  /// What the registry holds and hands back. Times are nanoseconds since the
  /// epoch, as the IC keeps them.
  public type Application = {
    name : Text;
    bundleSha256 : Text;
    bundleFileName : Text;
    created : Int;
    updated : Int;
    canisters : [CanisterEntry];
  };

  public type Error = {
    /// Anonymous callers have no records; sign in first.
    #anonymous;
    /// The name does not meet the rule above.
    #invalidName : Text;
    /// `create` of a name the caller already has.
    #alreadyExists : Text;
    /// `update` of a name the caller does not have.
    #notFound : Text;
  };

  /// Every caller's applications, by name.
  public type State = Map.Map<Principal, Map.Map<Text, Application>>;
};
