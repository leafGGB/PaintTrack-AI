# PaintTrack 二次开发与上游同步指南

本文说明如何在保留个人改动的前提下，持续获取原作者 `Open-Generative-AI` 的更新。

## 当前仓库配置

- 本地目录：`F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack`
- 个人 GitHub 仓库（`origin`）：`https://github.com/leafGGB/PaintTrack-AI.git`
- 原作者仓库（`upstream`）：`https://github.com/Anil-matcha/Open-Generative-AI.git`
- 当前个人开发分支：`my-work`
- 原作者主分支：`main`

> GitHub 仓库名和本地目录名是两件事。当前远程 URL 的仓库名仍是 `PaintTrack-AI`，虽然本地项目目录名为 `PaintTrack`。如果你之后也想把 GitHub 仓库从 `PaintTrack-AI` 改成 `PaintTrack`，请先在 GitHub 仓库 Settings 中重命名，再按本文“修改个人远程地址”一节更新本地 URL。

## 1. 打开仓库终端

在 Git Bash 中运行命令。以下命令均使用当前本地路径：

```bash
cd "F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack"
```

也可以在后续命令中使用完整的 `git -C "F:/.../PaintTrack"` 写法。

## 2. 每次开发前检查状态

```bash
git status --short --branch
git remote -v
git branch --show-current
```

确认：

- 当前分支为 `my-work`，不是 `main`。
- `origin` 指向自己的 GitHub 仓库。
- `upstream` 指向 `Anil-matcha/Open-Generative-AI`。
- 开始同步之前，工作区没有未提交改动。

如果当前分支不对，切换到自己的分支：

```bash
git switch my-work
```

如果工作区有改动，先查看具体内容：

```bash
git diff
git status
```

确认后提交，或暂存起来；不要在未理解这些改动的情况下直接同步上游。

## 3. 日常开发与提交

每项功能尽量独立提交，提交信息描述实际变更：

```bash
git add path/to/changed-file
 git commit -m "Describe the change"
```

例如：

```bash
git add packages/studio/src/components/ImageStudio.jsx
git commit -m "Add custom image generation controls"
```

检查提交和工作区：

```bash
git status
git log --oneline --decorate -8
```

把个人分支推送到自己的 GitHub 仓库：

```bash
git push -u origin my-work
```

第一次推送需要 GitHub 身份验证时，按 Git Credential Manager 的提示登录。不要把密码或访问令牌写进命令、脚本或仓库文件。

## 4. 获取原作者更新

先确保自己的改动已经提交，并确认工作区干净：

```bash
git status
```

然后获取上游提交：

```bash
git fetch upstream
```

`fetch` 只下载提交，不会修改当前工作文件。先检查上游带来了什么：

```bash
git log --oneline --decorate --graph HEAD..upstream/main
git diff --stat HEAD..upstream/main
git diff HEAD..upstream/main
```

确认要合并后，在个人开发分支执行：

```bash
git switch my-work
git merge upstream/main
```

Git 会自动合并能够无歧义组合的改动。同一文件的同一位置被双方修改时会产生冲突，需要人工处理；Git 不会保证语义正确，所以无冲突合并后也要验证功能。

## 5. 处理普通文件冲突

查看冲突文件：

```bash
git status
```

打开冲突文件，找到类似标记：

```text
<<<<<<< HEAD
你的 my-work 内容
=======
原作者 upstream/main 内容
>>>>>>> upstream/main
```

按最终需要手工保留或组合两边的代码，并删除所有冲突标记。不要盲目使用 `--ours` 或 `--theirs`，它们可能直接舍弃其中一方的改动。

处理完成后：

```bash
git add path/to/resolved-file
git status
git commit
```

Git 通常会预填合并提交信息，确认后保存提交即可。然后按项目实际情况运行安装、构建或测试，确认通过后推送：

```bash
git push origin my-work
```

如果合并尚未完成且决定放弃本次合并：

```bash
git merge --abort
```

只有在合并进行中、且尚未完成时使用 `merge --abort`。合并前先提交自己的改动，才能更可靠地回到原状态。

## 6. 同步自己的 GitHub 默认分支（可选）

`my-work` 是个人开发分支。若希望个人仓库的 `main` 也跟上原作者，可以在确认 `main` 没有个人专属改动后执行：

```bash
git switch main
git merge upstream/main
git push origin main
```

然后回到个人开发分支，将上游更新合入：

```bash
git switch my-work
git merge main
```

如果 `main` 上有个人改动，先检查并评估，不要直接合并覆盖。也可以完全不维护个人 `main`，只在 `my-work` 中合并 `upstream/main`。

## 7. 子模块注意事项

本项目包含 Git 子模块。主仓库记录子模块指向的提交号；子模块代码本身仍由子模块自己的 Git 仓库管理。

主仓库合并上游更新后，同步到主仓库指定的子模块版本：

```bash
git submodule update --init --recursive
```

检查子模块状态：

```bash
git submodule status
```

如果只是在主仓库同步原作者更新，通常由主仓库记录的新子模块提交号决定应该检出哪个版本。如果你亲自修改子模块中的文件，必须进入该子模块单独检查、提交和推送这些改动；随后回到主仓库，再提交更新后的子模块指针。只提交主仓库不会保存子模块里未提交的代码。

本仓库当前包含：

- `packages/Vibe-Workflow`
- `packages/Open-Poe-AI`
- `packages/Open-AI-Design-Agent`

子模块指针发生冲突时，先检查两边各自指向的提交及其变更，再决定使用哪个版本或如何迁移修改。不要把子模块目录当作普通文本文件，用冲突标记编辑。

## 8. 推荐的完整更新命令清单

确保没有未提交改动后执行：

```bash
git status
git fetch upstream
git log --oneline --decorate --graph HEAD..upstream/main
git diff --stat HEAD..upstream/main
git switch my-work
git merge upstream/main
git submodule update --init --recursive
git submodule status
```

如有冲突，人工解决并提交。之后根据变更范围验证项目；如果正常，推送到个人仓库：

```bash
git push origin my-work
```

## 9. 如果 GitHub 个人仓库也重命名了

先在 GitHub 仓库 Settings 中完成仓库重命名，再更新本地 `origin`。例如个人仓库最终叫 `PaintTrack`：

```bash
git remote set-url origin https://github.com/leafGGB/PaintTrack.git
git remote -v
git ls-remote origin HEAD
```

只有当 `git ls-remote origin HEAD` 能正常返回提交信息，才确认新地址可访问。若 GitHub 账号名或实际仓库名不同，请将 URL 替换成页面上显示的准确克隆地址。

## 10. 避免的危险操作

不要为了同步上游运行以下命令：

```text
git reset --hard upstream/main
git push --force
```

它们不是普通同步命令，可能丢弃本地提交或改写远程历史。正常流程使用 `fetch` + `merge`，并在合并前提交个人改动。

## 日常速查

```bash
# 开发并提交
 git switch my-work
 git status
 git add 相关文件
 git commit -m "描述改动"
 git push origin my-work

# 同步原作者
 git fetch upstream
 git switch my-work
 git merge upstream/main
 git submodule update --init --recursive
 git push origin my-work
```
