# 接入已有 CI（只提供示例，不自动修改项目）

沿用原 CI 的 Node、数据库及依赖准备方式。把计划、验收断言、适配器和工作流变更放入正常审阅范围；不要让实现 agent 为了变绿自己取消必测。执行器不是沙箱，运行未受信任 PR 时尤其不能给生产凭据或特权运行器。

以下为 POSIX shell 阶段示意；路径必须替换为实际项目，所需环境由受保护 CI 提供：

```sh
set -eu
SKILL_DIR=".agents/skills/doc-driven-development"
PLAN="docs/changes/actual-task.verify.json"
mkdir -p .doc-driven

# 在受保护流程中核对计划、适配器与断言的差异；取得当前被执行计划指纹。
HASH=$(node "$SKILL_DIR/scripts/verify.mjs" . --plan "$PLAN" --json |
  node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>process.stdout.write(JSON.parse(s).planHash))')
node "$SKILL_DIR/scripts/verify.mjs" . --plan "$PLAN" --run --expect-plan "$HASH" --json \
  > .doc-driven/verification-cli.json
RUN=$(node -e 'const r=require("./.doc-driven/verification-cli.json");process.stdout.write(r.path)')
node "$SKILL_DIR/scripts/verify.mjs" . --plan "$PLAN" --report "$RUN"
```

这是实际执行与采证阶段，不会自动更新仓库规格。提交前把 `--evidence` 输出中的证据检查后合入原验证区，维护当前状态和交付包，再执行本次范围的 --design/--release/--delivery。CI 重新运行产生的是独立运行记录，不假装旧的本地 run path 能在另一台机器天然存在。

历史证据在本地只保留引用、CI 产物下载缺失时，原文档静态检查可能提示本地工件缺失；不能通过虚构路径或改 Evidence 字段消除。可在可信 CI 中取回对应产物后核验，或为本次结果生成新记录。当前工具不是云端工件服务，不自动上传、下载或认证签名。

发布时分开说明：文档/设计检查、实际项目运行、范围覆盖、人工待验收和外部环境限制。使用 CI 的 always/失败保留机制保存失败日志，但先审阅和脱敏，不将所有 stdout 不加区分公开上传。禁用不相关可选测试必须有明确范围依据；必测被跳过不能由 CI 总 exit 0 覆盖。

参考 [GitHub Actions 安全强化指南](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) 的工作流审阅与隔离原则；这里只是宿主无关的执行阶段，不表示已经给用户仓库配置 CI。一般运行流程见 [VERIFICATION.md](../VERIFICATION.md)。
