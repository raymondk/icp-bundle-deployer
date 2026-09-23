/// The registry's interface: four methods, every one about the caller's own
/// records. Nobody can read another principal's list, and an anonymous caller
/// has no list to read.

import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Registry "../lib/Registry";
import Types "../types";

mixin (applications : Types.State) {
  /// The caller's applications, newest deployment first.
  public shared query ({ caller }) func list() : async [Types.Application] {
    Registry.list(applications, authenticated(caller));
  };

  public shared query ({ caller }) func get(name : Text) : async ?Types.Application {
    Registry.get(applications, authenticated(caller), name);
  };

  /// Fails if the caller already has an application with that name.
  public shared ({ caller }) func create(input : Types.ApplicationInput) : async Result.Result<Types.Application, Types.Error> {
    Registry.create(applications, caller, input, Time.now());
  };

  /// Fails if the caller has no application with that name.
  public shared ({ caller }) func update(input : Types.ApplicationInput) : async Result.Result<Types.Application, Types.Error> {
    Registry.update(applications, caller, input, Time.now());
  };

  /// A query has no error to return, so an anonymous read is refused outright.
  func authenticated(caller : Principal) : Principal {
    if (caller.isAnonymous()) {
      Runtime.trap("the registry has no applications for an anonymous caller; sign in first");
    };
    caller;
  };
};
