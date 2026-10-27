# Native manual-review verification

## Current evidence

The host-based tests in `adminStripeReviewLifecycle.test.tsx` cover:

- iOS and Android platform branches selecting a keyboard-aware scroll view with
  `keyboardShouldPersistTaps="handled"` and `bottomOffset={60}`.
- A note and selected outcome surviving successful 30-second polling, a failed
  poll, and the next successful poll.
- Rapid Save presses issuing one review request while the request is pending.
- Successful saving clearing the form and showing refreshed review history.
- Failed saving preserving the draft even when the subsequent refresh also fails.

These tests use a DOM host adapter. They **do not** exercise native layout,
keyboard occlusion, gestures, or actual iPhone/Android tapping.

Run them with:

```sh
pnpm --filter @workspace/mobile exec vitest run tests/adminStripeReview.test.tsx tests/adminStripeReviewLifecycle.test.tsx
```

## Native checks still required

Use the native app on an iPhone and an Android phone or their native simulators,
not Chrome/Safari mobile emulation. A browser URL does not provide native evidence.
Record device model, OS, app build, keyboard, orientation, and results.

Point the app at an isolated fixture API with a synthetic admin session and a
synthetic duplicate-payment queue row. Never use a real payment queue for these
checks. The fixture must support the queue GET and review-record POST; reject all
other mutations, including retry, ignore, and refund operations. Include several
rows so the form requires scrolling. Count review POSTs at the fixture boundary.
No synthetic fixture routes or admin bypasses should be exposed in the real app.

For **each** platform:

1. Scroll to a review form and select Needs follow-up.
2. Focus the note, enter a multiline operational note, and leave the keyboard open.
   Check the focused text/caret and Save button remain reachable by scrolling.
   Repeat near the bottom of the list and on a small display.
3. Wait through a 30-second poll that changes queue metadata. Verify focus, note,
   selection, and ability to scroll remain intact. Fail the next queue GET and
   verify the warning appears without losing the form; restore the following GET.
4. With the keyboard still open, tap Save once. Delay the response to allow a
   second rapid tap. Verify the first tap submits, exactly one POST occurs,
   and the form is disabled while saving.
5. Return a successful review response and include it in the next queue GET.
   Verify the note and selection clear and the review appears in history.
6. Enter a new draft. Fail the POST, then fail the refresh GET. Verify the note
   and selection remain, an explicit failure appears, and no automatic resubmission
   occurs. Restore queue reads without clearing the draft.

| Required evidence | iPhone | Android |
| --- | --- | --- |
| Native keyboard, note/caret and Save reachable | Not run | Not run |
| One native tap submits; rapid taps submit once | Not run | Not run |
| Draft and focus survive polling | Not run | Not run |
| Success clears form and refreshes history | Not run | Not run |
| Save/refresh errors retain the draft | Not run | Not run |

Do not mark the native checks as passed based on the host tests.
