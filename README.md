# FileRecall

Every download remembers where it came from.

FileRecall is a local-first browser extension that records the source, context, and history of downloaded files.

## v0.2.0 Alpha

- Search filenames, source domains and page titles with case-insensitive substring matching.
- Combine search with source and download status filters; results stay newest first and update automatically.
- Inspect download facts and source evidence, show a file in its folder, or explicitly open it from the detail view.

## Install or upgrade in Chrome

Use Chrome 123 or later for file opening with error feedback. No package installation or build step is needed.

1. Download and extract the repository source, or clone it locally.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Refresh any web pages already open, download a file, then click the FileRecall toolbar or extensions-menu icon.

To upgrade, update the files in the **same folder**, click **Reload** on the existing extension in `chrome://extensions`,
and reopen the history page. Refresh web pages to reload the download context capture script. Accept any permission
prompt for `downloads.open`, which enables the separate **Open file** action. Keep the same browser profile and extension
installation to retain local history; do not uninstall or clear extension storage to upgrade.

## Important limits

- History stays in this browser profile, with no cloud sync or import of past downloads. Search and filters only change the view.
- Confirmed sources use saved matching evidence. Candidates remain **unconfirmed**; unknown sources are searchable only by filename,
  without inferring a source from download URLs or referrers.
- File actions require a completed download, its Chrome download record and an accessible local file. FileRecall history survives
  loss of the Chrome record, but files that were moved or deleted are not tracked or downloaded again.
- Chrome's file existence check can lag. **Show in folder** cannot confirm the file manager's result; an accepted open request
  does not confirm that a system application displayed the file. Failures are shown in the detail view, with a recheck option.

## Run tests

With Node.js 22 or later:

```sh
node --test
```

