// The registry's rules, without a replica: the caller and the clock are
// parameters, so every rule the canister enforces is checked here directly.

import { test; suite } "mo:test";
import Array "mo:core/Array";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Registry "../src/registry/lib/Registry";
import Types "../src/registry/types";

let alice = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let bob = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");

func application(name : Text) : Types.ApplicationInput = {
  name;
  bundleSha256 = "ab" # "cd";
  bundleFileName = name # "-1.0.0.icp";
  canisters = [{ name = "backend"; canisterId = alice; state = #deployed }];
};

func fresh() : Types.State = Map.empty();

func expectOk(result : Result.Result<Types.Application, Types.Error>) : Types.Application {
  switch (result) {
    case (#ok(application)) application;
    case (#err(error)) { assert false; loop {} };
  };
};

suite("names", func() {
  test("accepts a trimmed name of printable characters", func() {
    assert Registry.validName("my-app");
    assert Registry.validName("My App 2");
    assert Registry.validName("a");
  });

  test("refuses an empty name and one over 64 characters", func() {
    assert not Registry.validName("");
    var long = "";
    for (_ in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].values()) { long #= "abcde" };
    assert long.size() == 65;
    assert not Registry.validName(long);
    assert Registry.validName(long.trimEnd(#char 'e'));
  });

  test("refuses surrounding whitespace and control characters", func() {
    assert not Registry.validName(" my-app");
    assert not Registry.validName("my-app\n");
    assert not Registry.validName("my\tapp");
  });
});

suite("create", func() {
  test("records the application with both timestamps set to now", func() {
    let state = fresh();
    let created = expectOk(Registry.create(state, alice, application("shop"), 1_000));
    assert created.created == 1_000;
    assert created.updated == 1_000;
    assert created.name == "shop";
    assert Registry.list(state, alice).size() == 1;
  });

  test("refuses a name the caller already has", func() {
    let state = fresh();
    ignore expectOk(Registry.create(state, alice, application("shop"), 1));
    assert Registry.create(state, alice, application("shop"), 2) == #err(#alreadyExists("shop"));
    assert Registry.list(state, alice).size() == 1;
  });

  test("refuses an invalid name", func() {
    assert Registry.create(fresh(), alice, application(" shop"), 1) == #err(#invalidName(" shop"));
  });

  test("refuses an anonymous caller", func() {
    let state = fresh();
    assert Registry.create(state, Principal.anonymous(), application("shop"), 1) == #err(#anonymous);
    assert state.isEmpty();
  });
});

suite("update", func() {
  test("keeps created and bumps updated", func() {
    let state = fresh();
    ignore expectOk(Registry.create(state, alice, application("shop"), 1_000));
    let input = { application("shop") with bundleFileName = "shop-2.0.0.icp" };
    let updated = expectOk(Registry.update(state, alice, input, 2_000));
    assert updated.created == 1_000;
    assert updated.updated == 2_000;
    assert updated.bundleFileName == "shop-2.0.0.icp";
    assert Registry.get(state, alice, "shop") == ?updated;
  });

  test("refuses a name the caller does not have", func() {
    assert Registry.update(fresh(), alice, application("shop"), 1) == #err(#notFound("shop"));
  });

  test("refuses an anonymous caller", func() {
    assert Registry.update(fresh(), Principal.anonymous(), application("shop"), 1) == #err(#anonymous);
  });
});

suite("listing", func() {
  test("shows a caller only their own applications", func() {
    let state = fresh();
    ignore expectOk(Registry.create(state, alice, application("shop"), 1));
    ignore expectOk(Registry.create(state, bob, application("blog"), 2));
    assert Registry.list(state, alice).map(func a = a.name) == ["shop"];
    assert Registry.list(state, bob).map(func a = a.name) == ["blog"];
    assert Registry.get(state, bob, "shop") == null;
  });

  test("a name is per caller, so two callers may use the same one", func() {
    let state = fresh();
    ignore expectOk(Registry.create(state, alice, application("shop"), 1));
    ignore expectOk(Registry.create(state, bob, application("shop"), 2));
    assert Registry.list(state, alice).size() == 1;
    assert Registry.list(state, bob).size() == 1;
  });

  test("orders by last deployment, newest first", func() {
    let state = fresh();
    ignore expectOk(Registry.create(state, alice, application("first"), 1));
    ignore expectOk(Registry.create(state, alice, application("second"), 2));
    ignore expectOk(Registry.update(state, alice, application("first"), 3));
    assert Registry.list(state, alice).map(func a = a.name) == ["first", "second"];
  });
});
