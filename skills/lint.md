---
name: lint
description: Enforce Dart class standards. Check props/_props contain ID (if exists) or all constructor params. Verify close/dispose methods exist and handle local state properly.
---

# Lint Skill

## Execution Steps

### Step 1: Locate Dart classes
```bash
find <target-dir> -name "*.dart" -type f | grep -v test | grep -v generated
```

### Step 2: Validate props/_props getters

For each Dart class:

1. Check if class has `props` or `_props` getter. Skip class if none found.
2. Read comments on `props` or `_props` to adjust linting behavior per comments.
3. Validate getter:
   - **If class has `id` or `idPepCon` parameter** → getter must return list containing that parameter ONLY, unless comments specify otherwise
   - **If class has no such parameter**
     - Parse constructor signature (all params: required, optional, named)
     - getter must return list of ALL constructor params, unless comments specify otherwise
4. When getter differs from expected behavior, record violation with:
   - file path
   - class name
   - getter name (`props` or `_props`)
   - missing fields
   - extra fields if present
   - reason when comment explicitly allows exclusion or custom behavior

### Step 3: Validate close/dispose methods

For each Dart class:

1. Analyze if class requires `close()` or `dispose()` (e.g., contains controllers, streams, timers, subscriptions, extends `ChangeNotifier`, etc.). Skip class if method unnecessary
2. Check for presence of `close()` or `dispose()` method.
3. Read comments on `close` or `dispose` to adjust linting behavior.
4. Verify method exists if required:
   - Verify method body contains cleanup logic:
     - Close/cancel streams, subscriptions
     - Dispose controllers, timers
     - Close file handles, DB connections
     - Stop isolates
   - Flag empty bodies or missing critical cleanup

### Step 4: Report

Summary report:
- Report both buckets:
  - `props/_props` violations
  - `close/dispose` violations
- Include file path for every violation
- Include class name for every violation
- For `props/_props` violations, include:
  - getter name
  - missing fields
  - extra fields if present
  - reason if comment allows exclusion or custom behavior
- For `close/dispose` violations, include:
  - missing method name, or invalid cleanup reason
  - resource requiring cleanup when identifiable
- If no violations in bucket, say `none`
- No general success/changelog output beyond violation report

Example format:
- `lib/foo.dart` — `AbsDetVM_HasAbsenceTypesList` — `_props` missing `absenceType`
- `lib/bar.dart` — `_SearchFieldState` — missing `dispose()` for `TextEditingController`

## Notes

- Ignore generated files (`*.g.dart`, `*.freezed.dart`)
- Ignore test files
- Props getter can use `Equatable`, `EquatableMixin`, or plain list
- Consider classes extending `ChangeNotifier` MUST have `dispose()`
- Consider classes with streams/subscriptions MUST have `close()` or `dispose()`
