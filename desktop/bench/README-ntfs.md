# NTFS catalog synthetic benchmark (v0.4.5)

Run from \`desktop/\`:

\`\`\`powershell
node bench/ntfs-catalog.mjs
\`\`\`

This uses 60,000 artificial filenames and paths held in a temporary in-memory SQLite database. It does **not** enumerate actual drives, read real filenames, collect browsing history, use network services, or upload user data. It reports only aggregate build time, database size, and p50/p95 query latency.

The prefix-match fast path uses \`ntfs_item_name(drive, folded)\`; uncommon infix and absent substrings still scan entries using \`instr()\`. These are workload-specific benchmarks, not full-disk acceptance criteria. Test a real disk locally for final validation; keep results private and publish only aggregate statistics with permission.


v0.4.6 adds indexed pinyin / initials lookup; the synthetic benchmark includes an `实验报告.pdf` name and verifies `pdf sybg`.
