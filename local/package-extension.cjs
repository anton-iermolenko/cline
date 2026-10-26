const path = require("node:path");
const fs = require("node:fs");
const { pack } = require("../apps/vscode/node_modules/@vscode/vsce/out/package.js");

const extensionRoot = path.resolve(__dirname, "../apps/vscode");
const version = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).version;
const packagePath = path.join(extensionRoot, "dist", `cline-${version}-local.vsix`);

pack({ cwd: extensionRoot, packagePath, dependencies: false, prepublish: false, allowUnusedFilesPattern: true })
  .then((result) => console.log(JSON.stringify({ packagePath: result.packagePath, files: result.files.length })))
  .catch((error) => { console.error(error); process.exitCode = 1; });
