# FileRecall

Every download remembers where it came from.

FileRecall is a local-first browser extension that records the source, context, and history of downloaded files.

## Try it in Chrome

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this repository, then refresh any pages already open before the extension was loaded.
3. Download a file and click FileRecall in the extensions menu or toolbar to open the download history.
4. Select a record to inspect the download facts, confirmed or candidate context, and matching evidence.

History is read-only and stored locally in this browser. Candidate sources remain explicitly unconfirmed.

## Run tests

With Node.js 22 or later:

```sh
node --test
```

No package installation or build step is needed.
