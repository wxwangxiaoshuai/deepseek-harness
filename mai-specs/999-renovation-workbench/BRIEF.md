# 999: 装修项目工作台

| 项 | 值 |
|---|---|
| Phase | dev |
| Profile | standard |
| 优先级 | P1 |
| 负责人 | wangxing |
| 目标日期 | 待填 |
| 涉及子系统 | 外部 Cordis Bundle、DSH Web、CAD、SQLite |

## 一句话描述

面向小型住宅装修团队提供 CAD 算量、报价、增减项和项目收支对账。

## 背景

图纸、报价 Excel 和现场收付款凭据分散，重复录入且难核对工程量、变更及尾款。

## 关键决策

通过独立 Web Bundle 交付报价与项目账。有效验收条件由 PRD 维护。

## 上下文索引

- [素材索引](context/_INDEX.md)
- [PRD 与有效验收条件](spec/PRD.md)
- [技术设计](design/TECH_DESIGN.md)
- [方案评审](review/design_review.md)
- [业务验收计划](test/TEST_PLAN.md)
- [代码评审](review/code_review.md)

已通过发布版 DSH Web 和合成 DWG 的跨模块烟测。真实项目、凭据验收以及源码构建仍未关闭。聊天接入及产品交互使用本轮新增验收条件。
