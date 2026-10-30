# Settings screenshot

`local-model-settings.png` is a headless Chromium capture of the real `LocalInferenceSettingsForm` React component, using VS Code dark-theme CSS variables in a standalone preview. It is an example configuration, not a capture of a user's account or an entire IDE window. No provider endpoint, credential or live conversation is used.

Source: `apps/vscode/webview-ui/src/components/settings/providers/LocalInferenceSettingsForm.tsx`. The component was unchanged for this screenshot.

The example selects Profile 1 for `qwen-27b-max-context`, with a maximum context of 153,600 tokens and normal output of 7,000 tokens. Compaction target and summary allowance use the component's calculated defaults. The allocation bar and every displayed budget value are produced by the actual shared budget calculation, not drawn or edited into the image. Advanced settings remain collapsed.

Refresh this image when profile controls or budget fields change. Render the component with public example values, wait for its configuration effect, verify the selected profile and allocation, then capture the component at 2× pixel density. Keep example values clearly labelled and preserve the distinction between estimated allocation and native request measurement.
