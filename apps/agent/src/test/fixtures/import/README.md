Fixture installs of the old package for `import.test.ts`. Each directory is a
home directory: the old config is `.config/omniralph/harness.json`. Tests copy a
fixture to a temp directory, replace `{{home}}` with its path and set the config
files to mode 0600 (git keeps only 0644).
