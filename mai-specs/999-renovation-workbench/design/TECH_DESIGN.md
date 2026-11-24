# 装修项目工作台技术方案

> Feature 999 · standard · 模板 ../../_templates/TECH_DESIGN.tmpl.md · 代码基线 4b399c39a6 · [需求与 AC](../spec/PRD.md)

## 方案

用仓库内独立的外部插件包验证正式安装入口 `dsh plugin --profile web add <bundle.tgz>`。插件注册认证后才可访问的工作台页面、资源和业务请求，复用 `webServer` 的来源与身份检查，业务 Handler 再校验 owner。插件自己的 SQLite 按 Harness home 存放，写入用事务，所有导出按项目查询，原始凭据按生成 ID 保存。插件注册通过 Cordis effect 可撤销。外置包独立验证，不进入产品默认组成。

## 领域模型与关键不变量

项目保存确定的报价版本、签约基线引用和独立的增减项、计划期款、流水及费用。金额用整数分，数量以明确单位和小数精度保存，乘积按分舍入。每笔收或付有客户端复用的操作 ID。确认基线和增减项后不覆盖，登记后续变更单。付款只减少指定费用的余额，报销也走同一路径。凭据与业务记录相互引用，只读回当前项目。

```ts
type Entry =
  | { kind: 'receipt', amountCents: number, installmentId?: string }
  | { kind: 'cost', amountCents: number, advancedBy?: string }
  | { kind: 'payment', amountCents: number, costId: string }

function outstanding(costCents: number, paidCents: number) {
  if (paidCents > costCents) throw new Error('payment_exceeds_cost')
  return costCents - paidCents
}
```

## 图纸和导入

在 Host 独立解析 DXF 实体。DWG 通过 Host 管理员安装并配置的本地转换器转换到同一输入，使用固定参数、唯一临时位置、大小限制和执行截止时间。正文给出支持范围。仅从可校核几何生成候选量，图上确认范围后才能进入报价。导入表按列名映射，未知或非法值逐行报告。浏览器交互使用可访问标签和原生表单，图纸预览使用 Canvas。图算明细会带上原图、边界、校准和测量方式的引用，Host 保存前复算。凭据草稿先由可选本地 Tesseract 处理图片。歧义字段留空，原文和图片留在工作台。DSH 模型识别与聊天应走有身份约束的工具调用，工作台数据不通过全局模型工具开放。

## 任务与验证

1. AC-01、04、05。项目与 SQLite 写入、对账、重试及版本。
2. AC-02、03。解析、短路径算量、选取和校准、Excel 和价格。
3. AC-06、07。凭据上传和提取、Web 标签页、报价和账目操作。
4. AC-08。真实 DSH Profile 验证、真实 DWG 与业务数据核验。

## 聊天报价、项目概览和资金账户

新注册的 Cordis 工具从当前会话已提交文件引用读取资料。只接受已记录 RPC 来源的所有者输入，排除继承消息、访客附件及任意磁盘路径。CAD 边界可在会话中引用，生成报告前 Host 复算。报价与关联 CAD 原文件在同一写入事务中保存，聊天只获得新文档的深链。手动报价、版本确认和下载仍从工作台进入。

SQLite v2 增加账户和转账记录，旧费用或付款缺账户时继续计入项目账。费用允许在同次记录里登记已付部分。资金流从实际记录派生，不从报价和期款派生。
