# 装修项目工作台

这是一个独立安装的 DeepSeek Harness Web 插件 Bundle。它在同一个项目中管理图纸算量、报价版本、增减项及施工收支。报价与项目账各自可以从已有项目开始。

## 安装

使用支持外部 Bundle 的 DSH Web 配置和 pnpm 11。以下命令在本仓库根目录运行。安装后重新启动 Web，登录后从侧栏进入「装修项目工作台」，也可访问同一站点的 `/renovation-workbench/`。

```sh
npm pack ./plugins/renovation-workbench
dsh plugin --profile web add ./dsh-renovation-workbench-0.2.2.tgz
dsh web
```

DXF 可直接处理。需要读取 DWG 时，在运行 DSH 的机器安装 GNU LibreDWG，并把 `dwg2dxf` 的绝对路径填到 Web profile 的 `cordis.patch.yml`。凭据图片的可选本地识别需要 Tesseract 和 `chi_sim`、`eng` 语言数据。以下两个字段可独立配置。

```yaml
- id: renovation-workbench
  config:
    dwgConverter: /opt/homebrew/bin/dwg2dxf
    ocrExecutable: /opt/homebrew/bin/tesseract
```

## 在 DSH 聊天里做报价

在普通 Web 聊天上传 DWG、DXF、报价 Excel 或文本资料，再发送「根据附件帮我做装修报价，先问我缺什么」。Agent 通过已注册的装修工具读取当前聊天的资料，确认范围、工程量、供料、价格和税口径后生成报价文档。聊天可按项目全名查找工作台项目，已有项目使用项目 ID 续版。同名工地需先确认具体项目，也可明确另建项目。Excel 明细每页读取 100 项，可按下一页偏移继续读取，最多支持 500 项。返回的链接直接打开工作台中的对应版本。聊天工具只接受所有者发起的 Web 会话，文件需来自该会话，报价不会自动确认或对外发送。

## 报价和项目账

- 上传文件最多 5 MiB，DWG 转出的 DXF 最多 32 MiB。支持模型空间中的 LINE 和无弧段的标准二维多段线。选择图形后可确认单位、按已知长度校准、取得长度或闭合面积。外部参照、图块、弧段和排版空间内容需要在 CAD 中整理或手填。保存的图算明细包含图纸及测量引用。原图可在当前项目重新打开。聊天优先列出有面积的闭合候选，支持按图层和偏移量翻页，返回每条边界在图纸中的坐标范围。房间归属和重复平面由用户核对。
- XLSX 的工作表包含 `施工项`、`单位`、`单价`，导入旧报价时同时包含 `数量`。可用的附加列为 `房间`、`供料` 和 `说明`。可用单位为 ㎡、m、个、点、项、套，供料列可填业主供料、团队供料、仅人工。有效团队价表对同一工作台内的项目生效。
- 保存报价会生成不可覆盖的版本。现场签约后可标为签约依据，有变化时另登记增减项并记录确认。客户报价、客户结算与项目账分别导出为 XLSX。
- 费用可关联分次付款。垫资属于一次费用，报销属于该费用的付款。接收多份凭据，重复文件会提示。凭据识别只填入有明确标识的候选字段，用户核对后保存。PDF、XML、OFD 可留作凭据。
- 预览的页面草稿在当前浏览器恢复。业务数据独立保存在 `$DSH_HOME/renovation-workbench/projects.sqlite`。工作台限 DSH Web owner 使用，一个 Harness home 对应一套数据。

同一浏览器标签页刷新后，如收款、付款或转账的提交结果待定，可点「核对并完成上次提交」复用原操作编号。核对成功后可以再登记一笔金额相同的新交易。预算草稿会保存报价用途，复制版本时也会沿用原用途。

账户可按微信、现金和银行卡分别登记。未填写期初金额时显示已录流水净额。账户互转只变动资金账户，分次付款与垫资报销只结清相应项目待付。

## 开发检查

在本目录运行 `npm ci --ignore-scripts` 和 `node --test test/workbench.test.js`。HTTP 测试使用装载替身与真实本机 HTTP，业务验收使用实际 DSH Web profile。

[Feature 999 规格](../../mai-specs/999-renovation-workbench/spec/PRD.md) · [业务验收计划](../../mai-specs/999-renovation-workbench/test/TEST_PLAN.md)
