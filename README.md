# FileRecall

Every download remembers where it came from.

FileRecall is a local-first browser extension that records the source, context, and history of downloaded files.

## v0.3.0

- Import Chrome's existing download history on demand, up to 100 records per click. Continue with the next batch;
  existing FileRecall records are preserved and failed records can be retried by restarting the import.
- Confirm or reject candidate sources directly in the detail view. Add or edit a page URL and optional title for unknown
  or rejected sources, and undo manual source decisions to restore the original algorithm judgment.
- Add, edit or clear notes. Search filenames, effective source domains/page titles and notes with case-insensitive substring matching.
- Combine search with source and download status filters; results stay newest first and update automatically.
- Distinguish automatic matches, manually confirmed candidates, manually entered pages, unconfirmed candidates and unknown/rejected sources.
  Manual source decisions and notes are stored separately from the original algorithm evidence.
- Inspect download facts and original source evidence, show a file in its folder, or explicitly open it from the detail view.

## Install or upgrade in Chrome

Use Chrome 123 or later for file opening with error feedback. No package installation or build step is needed.

1. Extract the `FileRecall-v0.3.0.zip` package if provided, or download/clone the repository source into a stable local folder.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Refresh any web pages already open, then click the FileRecall toolbar or extensions-menu icon.
   Import existing Chrome history from the history page, or download a new file to start recording its context.

To upgrade, update the files in the **same folder**, click **Reload** on the existing extension in `chrome://extensions`,
and reopen the history page. Refresh web pages to reload the download context capture script. Accept any permission
prompt for `downloads.open`, which enables the separate **Open file** action. Keep the same browser profile and extension
installation to retain local history; do not uninstall or clear extension storage to upgrade.
Download history, source decisions and notes are retained when reloading the same installation. This update adds no new permissions.

## Important limits

- History, annotations and notes stay in this browser profile, with no cloud sync or backup service. Search and filters only change the view.
- Import can only retrieve records still kept by Chrome. Imported records initially have unknown sources because past click context
  cannot be recovered; FileRecall does not infer a source from download URLs or referrers.
  Exceptionally large groups sharing the exact same timestamp stop with an explicit pagination error instead of silently skipping history.
- Unconfirmed candidates remain explicitly labeled until a user acts. Manual confirmation does not turn an algorithm candidate into
  an automatic match. Rejected pages are excluded from effective source search; filenames and notes remain searchable.
- File actions require a completed download, its Chrome download record and an accessible local file. FileRecall history survives
  loss of the Chrome record, but files that were moved or deleted are not tracked or downloaded again.
- Chrome's file existence check can lag. **Show in folder** cannot confirm the file manager's result; an accepted open request
  does not confirm that a system application displayed the file. Failures are shown in the detail view, with a recheck option.

## Run tests

With Node.js 22 or later:

```sh
node --test
git diff --check
```

## Release package

The unpacked extension needs `manifest.json`, `background.js`, `content.js`, `context-matcher.mjs`, `download-record-store.mjs`,
`history.html`, `history.css`, `history.js`, `history-view.mjs`, `history-file-actions.mjs` and `history-import.mjs` at the package root.
Include this README and LICENSE. Exclude `*.test.mjs`, `.git/`, `.gitignore`, development files and previous ZIP archives.
