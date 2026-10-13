# Storage

## Temp folder (`TMP`)

- `$TMPDIR/claude-show-your-work-<uid>`, made with mode 700 (`PICK_TMP`). Holds video frame folders, converted stills and shrunk copies for ssh.
- Anything older than a week is deleted at session start (`CLEAN_SH`), without following links.
- Frame folders are capped at `FRAMES_CAP_KB` (500 MB), oldest first (`TRIM_SH`). The trim only touches folder names the plugin makes (`v-<hex>`, `v<n>-<time>`, `p-<hex>`, `p2-<hex>`), never the two newest, and never through a link.
- Claude is told (in both tool descriptions) to save screenshots and recordings it makes only to show in a temp folder, not in the project.

## History store

- Every shown file is kept as a version in `.show-your-work/` in the project (`${TMP}/store` as a fallback), so old versions survive when the file changes. The folder ignores itself in git.
- Each version is `<id><ext>` plus `<id>.json` (6-hex id). A revision names its parent's id as `previous`, so history is a chain of explicit links. No file names are matched.
- **Copies are copy-on-write clones** (`cp -c` on APFS, `cp --reflink=auto` on Linux, a plain `cp` otherwise). A clone takes no space until the original changes. Measured: 10 clones of a 721 KB file used 0 KB.
- Capped at `HISTORY_CAP_KB` (500 MB) across every history folder this install has used (`historyDirs` in the plugin store), oldest first, never the version just kept (`HISTORY_TRIM_SH`). Together with frames that's about 1 GB.
- Each version shows one line in History: its first change and "and N more", cut at a word (`noteOf`, `oneLine`).

## Safety rules (from issue #4 and the review after it)

- Never word-split a path: `while IFS= read -r`, quoted variables, `cd -P` into the folder and work with bare names.
- Never follow a link: check `[ ! -L ]` and `[ -O ]` (owned by this user) before writing or deleting.
- Delete only names the plugin makes (strict patterns), so a user's own file can never match.
- Paths with spaces must work: test the scripts in a temp folder with spaces in its name.
