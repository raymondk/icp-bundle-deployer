/// The registry's rules, over state handed in: who may see and write what,
/// what a name may be, and what is stamped when.
///
/// Nothing here knows the caller from the message or the time from the clock;
/// both are parameters, which is what lets the rules be tested without a
/// replica.

import Array "mo:core/Array";
import Char "mo:core/Char";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Types "../types";

module {
  public let NAME_MAX_LENGTH : Nat = 64;

  /// Whether `name` is one the registry accepts: 1 to 64 characters, none of
  /// them control characters, and no whitespace at either end. The page
  /// applies the same rule before sending, so a refusal here means a client
  /// that skipped it.
  public func validName(name : Text) : Bool {
    let size = name.size();
    if (size == 0 or size > NAME_MAX_LENGTH) return false;
    if (name != name.trim(#predicate isWhitespace)) return false;
    for (c in name.chars()) {
      if (isControl(c)) return false;
    };
    true;
  };

  func isWhitespace(c : Char) : Bool = c == ' ' or c == '\t' or c == '\n' or c == '\r';

  func isControl(c : Char) : Bool {
    let code = c.toNat32();
    code < 32 or code == 127;
  };

  /// The caller's applications, newest deployment first.
  public func list(state : Types.State, caller : Principal) : [Types.Application] {
    let applications = switch (state.get(caller)) {
      case (?own) own.values().toArray();
      case null [];
    };
    applications.sort(func(a, b) = Int.compare(b.updated, a.updated));
  };

  public func get(state : Types.State, caller : Principal, name : Text) : ?Types.Application {
    switch (state.get(caller)) {
      case (?own) own.get(name);
      case null null;
    };
  };

  /// Records a new application for `caller`, stamped `now`. Refused for a
  /// name the caller already has: the name is what an upgrade is looked up
  /// by, so it is reserved here, before anything is deployed under it.
  public func create(
    state : Types.State,
    caller : Principal,
    input : Types.ApplicationInput,
    now : Int,
  ) : Result.Result<Types.Application, Types.Error> {
    if (caller.isAnonymous()) return #err(#anonymous);
    if (not validName(input.name)) return #err(#invalidName(input.name));
    let own = ownApplications(state, caller);
    if (own.containsKey(input.name)) return #err(#alreadyExists(input.name));
    let application : Types.Application = {
      name = input.name;
      bundleSha256 = input.bundleSha256;
      bundleFileName = input.bundleFileName;
      created = now;
      updated = now;
      canisters = input.canisters;
    };
    own.add(input.name, application);
    #ok(application);
  };

  /// Replaces what is recorded under a name `caller` already has, keeping when
  /// it was created and stamping `now` as when it was last deployed.
  public func update(
    state : Types.State,
    caller : Principal,
    input : Types.ApplicationInput,
    now : Int,
  ) : Result.Result<Types.Application, Types.Error> {
    if (caller.isAnonymous()) return #err(#anonymous);
    if (not validName(input.name)) return #err(#invalidName(input.name));
    let own = ownApplications(state, caller);
    switch (own.get(input.name)) {
      case null #err(#notFound(input.name));
      case (?previous) {
        let application : Types.Application = {
          name = input.name;
          bundleSha256 = input.bundleSha256;
          bundleFileName = input.bundleFileName;
          created = previous.created;
          updated = now;
          canisters = input.canisters;
        };
        own.add(input.name, application);
        #ok(application);
      };
    };
  };

  /// The caller's own map, made on first use.
  func ownApplications(state : Types.State, caller : Principal) : Map.Map<Text, Types.Application> {
    switch (state.get(caller)) {
      case (?own) own;
      case null {
        let own = Map.empty<Text, Types.Application>();
        state.add(caller, own);
        own;
      };
    };
  };
};
