# Monster Recon: marketing kit

Made with the `promote-scene` skill (decentraland/sdk-skills PR #129, unreleased) on 2026-10-23. Excluded from deploys by `.dclignore`.

Link: https://decentraland.org/jump/?realm=monsterrecon.dcl.eth

## Files

- `index.html`: open in a browser (works offline). Preview each post as X or Instagram, edit, copy text or image, download.
- `posts.json`: single source of truth: 18 posts (launch 4, coming soon 4, footage 5, quote 3, behind the scenes 2), listing copy, hashtags, image list.
- `kit-data.js`: generated from `posts.json` for the page. Do not edit.
- `copy.md`: every post and the listing copy as plain text.
- `footage-shotlist.md`: what to record in the Explorer for the footage posts.
- `images/keyart/`: copies of `assets/images/thumbnail.png` (Halloween Edition, 1920x1080) and `assets/images/square-thumbnail.png` (1254x1254).
- `images/social/`: 1080x1080 cards made from `assets/images/prizes_01.png`: the Monster Codex with the two Epics locked, four monster portraits, three quote cards.
- `tools/`: `make_images.py` (this kit's own script) and `build_kit.py` (from the skill).

## Regenerate (from the scene folder)

```
python promote/tools/make_images.py
PYTHONUTF8=1 python promote/tools/build_kit.py
```

`PYTHONUTF8=1` (PowerShell: `$env:PYTHONUTF8=1`) avoids Windows encoding errors when the copy has non-ASCII characters. Requires Pillow.

## Notes

- Not produced this run (first-run scope chosen by the creator): logo set, Blender renders, composed key art with wordmark, X header, videos. The monsters are 2D sprites, so 3D renders would add little.
- Footage posts are placeholders until clips are recorded. Recordings go in `promote/footage/`.
- `soon-04` contains a `[CHECK]`: delete it unless a second monster collection is actually planned.
- Epic monsters are kept out of images and the shot list by default (agent choice, not confirmed).
- Inspirations and comparisons: kept out of the copy.
- Weekly rewards are mentioned only generically (no amounts or currency), per the creator.
- Handles are `@yourhandle` placeholders.

## Rights

All art comes from the scene's own assets. Board music is credited to Bensound in the scene description; credits stay in the description, not in posts. The title was not checked for trademark conflicts. Decentraland is named in posts as the platform only; no Decentraland logo is used.

## Marketing package status

- Short and long description: in the kit (`listing`).
- Thumbnail: exists, but see the metadata findings below.
- Clean in-world 16:9 gameplay screenshot (no UI): missing, see the shot list.
- Trailer (under 30 s, 16:9 + 9:16): missing, shot order in `footage-05`.

## Metadata findings (scene.json)

- Description is ~260 characters before the credits. Proposed rewrite = `listing.short` (136 characters), keeping the credits line after it.
- `tags` is empty: add `"game"`.
- `assets/images/thumbnail.png` is 1,102,836 bytes, over the 1 MB Worlds thumbnail limit, and its title text runs outside the central 1080x1080 area.
