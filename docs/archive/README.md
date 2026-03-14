# docs/archive

本目录用于保存历史取证文件与恢复前快照，不作为当前实现文档的输入源。

## 编码相关约束

- `focus-console-design.corrupted-20260228-154326.before-recover-20260228-161303.md` 与 `focus-console-design.corrupted-20260228-154326.md` 均为乱码取证样本。
- 这两份文件保留用于追溯，不参与正常文档维护，也不纳入 BOM 清理。
- 编码门禁脚本 `scripts/contracts/check-encoding-corruption.cjs` 已显式排除此类 `.corrupted*` 样本。
