# 发版流程

## 为什么资产名不带版本号

插件市场的收录条目用 `latest/download/` 指向 tarball：

```yaml
tarball: https://github.com/kennethfan/dsh-sandbox-tune/releases/latest/download/dsh-sandbox-tune.tgz
```

`latest` 在请求时才解析到最新 Release，但**文件名是照字面取的**。
如果资产名带版本号（`dsh-sandbox-tune-0.1.0.tgz`），链接提交当天有效，
下次发版就会 404 —— 而且不会有人察觉。

所以资产名固定为 `dsh-sandbox-tune.tgz`，版本号只体现在 tag 上。

## 步骤

```sh
# 1. 改版本号与 CHANGELOG
#    package.json 的 version
#    CHANGELOG.md 顶部加新条目

# 2. 提交
git add -A
git commit -m "..."

# 3. 打 tag 并推送
git tag -a v0.1.1 -m "v0.1.1"
git push origin master v0.1.1

# 4. 打包并改名（关键：去掉版本号）
npm pack
mv dsh-sandbox-tune-*.tgz dsh-sandbox-tune.tgz

# 5. 创建 Release 并上传
gh release create v0.1.1 ./dsh-sandbox-tune.tgz \
  --title "v0.1.1 — 简述" \
  --notes-file /tmp/notes.md

# 6. 清理本地 tarball
rm -f dsh-sandbox-tune.tgz
```

## 验证

```sh
# 链接可用（应返回 200）
curl -sIL https://github.com/kennethfan/dsh-sandbox-tune/releases/latest/download/dsh-sandbox-tune.tgz | grep -E "^HTTP|content-length"

# 解包可用
cd /tmp && curl -sL -o p.tgz https://github.com/kennethfan/dsh-sandbox-tune/releases/latest/download/dsh-sandbox-tune.tgz
tar -xzf p.tgz && cd package && node --test test/*.test.mjs
```

## 注意

- 资产名必须**不带版本号**，否则 `latest/download` 链接会随下次发版失效
- `npm pack` 生成的文件名由 `package.json` 的 `name` + `version` 决定，所以每次都要 `mv`
- 收录条目里的 `tarball` 字段**不需要**随发版改动（这正是用 `latest` 的目的）
