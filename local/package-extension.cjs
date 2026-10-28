const path = require("node:path");
const fs = require("node:fs");

const extensionRoot = path.resolve(__dirname, "../apps/vscode");
const vsceRoot = path.dirname(require.resolve("@vscode/vsce/package.json", { paths: [extensionRoot] }));
const { pack } = require(path.join(vsceRoot, "out/package.js"));
const version = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).version;
const release = JSON.parse(fs.readFileSync(path.join(__dirname, "release.json"), "utf8"));
if (version !== release.version) throw new Error("Package with local/build-wsl.sh so both clients receive the fork version");
const provenance = JSON.parse(fs.readFileSync(path.join(extensionRoot, "dist/source-provenance.json"), "utf8"));
const sourceUrl = `${release.repository}/blob/${provenance.sourceCommit}/`;
const imageUrl = `${release.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${provenance.sourceCommit}/`;
const packagePath = path.join(extensionRoot, "dist", `cline-ai-local-${version}.vsix`);

// pack() packages existing artifacts directly, without a second prepublish build.
pack({ cwd: extensionRoot, packagePath, dependencies: false, allowUnusedFilesPattern: true, baseContentUrl: sourceUrl, baseImagesUrl: imageUrl })
  .then((result) => console.log(JSON.stringify({ packagePath: result.packagePath, files: result.files.length })))
  .catch((error) => { console.error(error); process.exitCode = 1; });
