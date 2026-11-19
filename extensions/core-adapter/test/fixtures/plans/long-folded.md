# Move the report export to a background job

## For the owner

**Goal:** Large reports are built in the background, so the page answers at once and the owner gets a download link when the file is ready.

1. The export button starts a job and shows a waiting message.
2. The job builds the file and stores it for seven days.
3. The page shows the download link when the job ends.

> [!WARNING]
> **Heads-up**
>
> - Reports older than seven days must be built again.

## Decisions and assumptions

| Topic | Decision | Reason |
| --- | --- | --- |
| Storage | Seven days | Keeps the disk small |
| Queue | One job at a time per user | Avoids a flood |

## Context

The export runs in the request today. A report of 50000 rows takes about `40` seconds, and the browser gives up before that.

## Approach

- Split the export into a start call and a status call.
- Keep the file builder as it is.
- Poll the status call every two seconds.

## Notes

First note: the status call needs no login check of its own.

## Risks

1. A job that crashes must not block the queue.
2. A user who closes the page still finds the link later.

## Notes

Second note, same heading: the old export route stays for one release.

## Tests

- A job that ends shows the link.
- A job that fails shows one clear message.

## Work

1. Add the start call and the status call.
2. Change the page to poll.
3. Add the tests.

## Rollout

Ship behind a switch, turn it on for one team first, then for all.
