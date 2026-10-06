# 📖 `clever migrate` command reference

## ➡️ `clever migrate` <kbd>Unreleased</kbd>

Analyze a project and list what is missing to deploy it on Clever Cloud

```bash
clever migrate [<path>] [options]
```

### 📥 Arguments

|Name|Description|
|---|---|
|`path`|Path of the project to analyze (current directory if not specified) *(optional)*|

### ⚙️ Options

|Name|Description|
|---|---|
|`-F`, `--format` `<format>`|Output format (human, json) (default: human)|
|`-n`, `--name` `<app-name>`|Application name used in the migration plan (current directory name by default)|
|`--strict`|Exit with code 1 if blockers are found (useful in CI)|
|`-t`, `--type` `<instance-type>`|Force the target instance type instead of detecting it|
|`--write`|Write the proposed configuration files (existing files are never overwritten)|

## ➡️ `clever migrate apply` <kbd>Unreleased</kbd>

Prepare the project for Clever Cloud on a new git branch or in a copy of the project

```bash
clever migrate apply [<path>] [options]
```

### 📥 Arguments

|Name|Description|
|---|---|
|`path`|Path of the project to migrate (current directory if not specified) *(optional)*|

### ⚙️ Options

|Name|Description|
|---|---|
|`--branch` `<branch-name>`|Name of the branch to create (default: clever-cloud-migration)|
|`--dry-run`|Show what would be done without writing anything|
|`-F`, `--format` `<format>`|Output format (human, json) (default: human)|
|`--mode` `<mode>`|Where to write the changes: a new git branch, a copy of the project, or auto (branch if the git repository is clean, folder otherwise) (auto, branch, folder) (default: auto)|
|`-n`, `--name` `<app-name>`|Application name (current directory name by default)|
|`-o`, `--output` `<folder>`|Folder of the copy in folder mode (default: <project>-clever next to the project)|
|`--skip-code`|Do not modify source files, only generate configuration files|
|`-t`, `--type` `<instance-type>`|Force the target instance type instead of detecting it|
