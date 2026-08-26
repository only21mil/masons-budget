# Source Code Pro provenance

The app bundles the upright TrueType cuts required by the ledger design. They
come from Adobe's official Source Code Pro release without modification.

- Upstream: https://github.com/adobe-fonts/source-code-pro
- Release: `2.042R-u/1.062R-i/1.026R-vf`, published 2023-04-12
- Release commit: `d3f1a5962cde503f9409c21e58527611d4a19ef1`
- License: SIL Open Font License 1.1, copied in `LICENSE.md`

`project.yml` copies all five files into both app bundles. The iOS target lists
each filename under `UIAppFonts`; the macOS target loads the resource root with
`ATSApplicationFontsPath`. SwiftUI must use these PostScript names:

| Weight | File | PostScript name |
| --- | --- | --- |
| 300 | `SourceCodePro-Light.ttf` | `SourceCodePro-Light` |
| 400 | `SourceCodePro-Regular.ttf` | `SourceCodePro-Regular` |
| 500 | `SourceCodePro-Medium.ttf` | `SourceCodePro-Medium` |
| 600 | `SourceCodePro-Semibold.ttf` | `SourceCodePro-Semibold` |
| 700 | `SourceCodePro-Bold.ttf` | `SourceCodePro-Bold` |

`SHA256SUMS` records the bundled bytes. Update provenance and hashes together
if the release ever changes.
