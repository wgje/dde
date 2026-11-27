# Current metadata extension v1

The historical overlay-v1 descriptor and schema digest remain frozen. Current generated output uses the registered identity nanoflow-current-metadata/1, with a separate current-schema contract and generation contract. Unknown digests are rejected, not negotiated.

Exact additions:

- variable node migration-constraint-validation: relation, table; its existing producer ID is constraint-validation:<name>:<table>:<startLine>.
- variable node migration-index: relation, table, columns, method, unique, concurrently, predicate.
- references edge migration-index: relation, indexName, table, columns, method, unique, concurrently, predicate.

No unknown keys, unrelated relation names, reordered keys, invalid node IDs, dangling edges, source-path drift, scalar types or safety limits are relaxed. The unchanged predecessor streaming parser and graph validator algorithm run in an isolated registered descriptor profile. A cloned graph descriptor adds only the listed tables and the exact existing validation ID pattern. Its computed descriptor digest, descriptor-manifest digest and schema digest bind the current contract. The producer consumes the same registered node orders. Publication and readback choose the same exact schema digest; the generation checksum chain includes that digest and the current generation contract digest. Old generations continue using the original dependency closure and predecessor validator.

This extension does not claim to fix wrapper timing/outcome diagnostic failures. Those require independent attribution and regression evidence. It also does not mean a new repository CURRENT exists: runtime closure, base sync, controlled generation, doctor and fresh host smoke remain separate verification steps.
