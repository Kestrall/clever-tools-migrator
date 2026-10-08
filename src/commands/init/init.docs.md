# 📖 `clever init` command reference

## ➡️ `clever init` <kbd>Unreleased</kbd>

Generate a minimal working project for a runtime in the current directory and create its application

```bash
clever init <runtime> [<app-name>] [options]
```

### 📥 Arguments

|Name|Description|
|---|---|
|`runtime`|Runtime of the project: docker, node, python, php|
|`app-name`|Application name (current directory name is used if not specified) *(optional)*|

### ⚙️ Options

|Name|Description|
|---|---|
|`-a`, `--alias` `<alias>`|Short name for the application|
|`-d`, `--deploy`|Deploy the application right after its creation|
|`-F`, `--format` `<format>`|Output format (human, json) (default: human)|
|`--local`|Only generate the project files, do not create the application on Clever Cloud|
|`-o`, `--org`, `--owner` `<org-id\|org-name>`|Organisation to target by its ID (or name, if unambiguous)|
|`-r`, `--region` `<zone>`|Region, can be 'par', 'parhds', 'grahds', 'rbx', 'rbxhds', 'scw', 'ldn', 'mtl', 'sgp', 'syd', 'wsw' (default: par)|
