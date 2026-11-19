# Add a retry to the upload

## For the owner

**Goal:** Uploads that fail once try again, so a short network drop no longer loses a file.

1. The upload tries again up to three times.
2. Each try waits a little longer than the one before.
3. After the last try the owner sees one clear message.

> [!WARNING]
> **Heads-up**
>
> - A slow network makes an upload take longer before it gives up.

> [!NOTE]
> **Decided for you**
>
> - Three tries, because more would hide a real outage.

## Decisions and assumptions

| Topic | Decision |
| --- | --- |
| Tries | Three |
| Wait | Doubles after each try |

## Work

1. Add the retry loop.
2. Add a test for the loop.
