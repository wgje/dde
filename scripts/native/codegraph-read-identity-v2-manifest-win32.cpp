#include "codegraph-read-identity-v2-win32.hpp"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include <algorithm>

namespace codegraph_source_policy_v2 {
namespace {

std::string JsonNumber(uint64_t value) {
  return std::to_string(value);
}

std::vector<unsigned char> Bytes(std::string_view value) {
  return std::vector<unsigned char>(value.begin(), value.end());
}

std::string PolicyDefinitionDigest() {
  return std::string(CODEGRAPH_READ_IDENTITY_V2_POLICY_DEFINITION_DIGEST);
}

std::string PathSetDigest() {
  return std::string(CODEGRAPH_READ_IDENTITY_V2_PATH_SET_DIGEST);
}

V2ProjectionResult EmptyResult() {
  V2ProjectionResult result;
  result.aggregateRawBytes = "0";
  result.capturedRawDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-captured-raw-v3")}});
  result.contentDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-content-v3")}});
  result.entryCount = "0";
  result.finalCensusDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-final-census-v3")}});
  result.finalProjectionCoreDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-final-projection-core-v3")}});
  result.initialCensusDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-initial-census-v3")}});
  result.metadataDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-metadata-v3")}});
  result.pathSetDigest = PathSetDigest();
  result.sourcePolicyDigest = Cg2FieldV3Digest({
    {"domain", Bytes("empty-source-policy-v3")}});
  return result;
}

std::vector<std::pair<std::string_view, std::string>> CommonFields(
  const V2Session& session) {
  return {
    {"operation", Cg2JsonString(session.operation)},
    {"protocol", Cg2JsonString(kProtocol)},
    {"receiptSha256", Cg2JsonString(session.receiptSha256)},
    {"rootIdentity", Cg2JsonString(session.rootIdentity)},
    {"sessionId", Cg2JsonString(session.sessionId)},
    {"snapshotId", Cg2JsonString(session.snapshotId)},
  };
}

}  // namespace

bool Cg2EmitManifestFrames(
  const V2Session& session,
  const std::vector<V2Tuple>& tuples,
  const std::vector<V2Captured>& captures,
  const std::vector<V2Projection>& projections,
  const V2ProjectionResult& result) {
  (void)tuples;
  const std::vector<std::pair<std::string_view, std::string>> common =
    CommonFields(session);
  auto object = [&common](std::vector<std::pair<std::string_view, std::string>> fields) {
    fields.insert(fields.end(), common.begin(), common.end());
    return Cg2JsonObject(fields);
  };

  if (!Cg2EmitFrame(object({
    {"chunkCount", JsonNumber(
      (captures.size() + kMaxChunkElements - 1) / kMaxChunkElements)},
    {"entryCount", JsonNumber(captures.size())},
    {"initialCensusDigest", Cg2JsonString(result.initialCensusDigest)},
    {"kind", Cg2JsonString("start")},
    {"pathSetDigest", Cg2JsonString(result.pathSetDigest)},
    {"phase", Cg2JsonString("census")},
  }))) {
    return false;
  }

  for (size_t entryIndex = 0; entryIndex < captures.size(); ++entryIndex) {
    if (!Cg2EmitFrame(object({
      {"censusTuple", Cg2TupleJson(captures[entryIndex].tuple)},
      {"entryIndex", Cg2JsonString(std::to_string(entryIndex))},
      {"kind", Cg2JsonString("initialCensus")},
      {"phase", Cg2JsonString("census")},
    }))) return false;
  }

  const size_t chunkCount = (captures.size() + kMaxChunkElements - 1) / kMaxChunkElements;
  for (size_t chunkIndex = 0; chunkIndex < chunkCount; ++chunkIndex) {
    V2ManifestChunk chunk;
    chunk.chunkIndex = std::to_string(chunkIndex);
    chunk.chunkCount = std::to_string(chunkCount);
    const size_t begin = chunkIndex * kMaxChunkElements;
    const size_t end = std::min(captures.size(), begin + kMaxChunkElements);
    for (size_t index = begin; index < end; ++index) chunk.items.push_back(captures[index].tuple);
    chunk.cursorBefore = Cg2Base64Url(Bytes(std::to_string(chunkIndex)));
    chunk.cursorAfter = Cg2Base64Url(Bytes(std::to_string(chunkIndex + 1)));
    chunk.chunkDigest = Cg2ChunkDigest(session, chunk);
    std::vector<std::string> items;
    for (const V2Tuple& tuple : chunk.items) items.push_back(Cg2TupleJson(tuple));
    if (!Cg2EmitFrame(object({
    {"chunkCount", JsonNumber(chunkCount)},
      {"chunkDigest", Cg2JsonString(chunk.chunkDigest)},
    {"chunkIndex", JsonNumber(chunkIndex)},
      {"cursorAfter", Cg2JsonString(chunk.cursorAfter)},
      {"cursorBefore", Cg2JsonString(chunk.cursorBefore)},
      {"items", Cg2JsonArray(items)},
      {"kind", Cg2JsonString("chunk")},
      {"phase", Cg2JsonString("read")},
    }))) return false;
    for (size_t index = begin; index < end; ++index) {
      if (!Cg2EmitFrame(object({
        {"capturedEntry", Cg2CapturedJson(captures[index])},
        {"kind", Cg2JsonString("captured")},
        {"phase", Cg2JsonString("read")},
      }))) return false;
    }
  }

  for (size_t entryIndex = 0; entryIndex < captures.size(); ++entryIndex) {
    if (!Cg2EmitFrame(object({
      {"censusTuple", Cg2TupleJson(captures[entryIndex].tuple)},
      {"entryIndex", Cg2JsonString(std::to_string(entryIndex))},
      {"kind", Cg2JsonString("finalCensus")},
      {"phase", Cg2JsonString("attestation")},
    }))) return false;
  }

  for (size_t entryIndex = 0; entryIndex < captures.size(); ++entryIndex) {
    if (!Cg2EmitFrame(object({
      {"kind", Cg2JsonString("projection")},
      {"phase", Cg2JsonString("source-policy")},
      {"projectionEntry", Cg2ProjectionJson(projections[entryIndex])},
    }))) return false;
  }

  if (!Cg2EmitFrame(object({
    {"aggregateRawBytes", Cg2JsonString(result.aggregateRawBytes)},
    {"capturedRawDigest", Cg2JsonString(result.capturedRawDigest)},
    {"contentDigest", Cg2JsonString(result.contentDigest)},
    {"entryCount", Cg2JsonString(result.entryCount)},
    {"finalCensusDigest", Cg2JsonString(result.finalCensusDigest)},
    {"finalProjectionCoreDigest", Cg2JsonString(result.finalProjectionCoreDigest)},
    {"initialCensusDigest", Cg2JsonString(result.initialCensusDigest)},
    {"kind", Cg2JsonString("end")},
    {"metadataDigest", Cg2JsonString(result.metadataDigest)},
    {"pathSetDigest", Cg2JsonString(result.pathSetDigest)},
    {"phase", Cg2JsonString("attestation")},
    {"sourcePolicyDigest", Cg2JsonString(result.sourcePolicyDigest)},
  }))) {
    return false;
  }

  return Cg2EmitFrame(object({
    {"kind", Cg2JsonString("finalSuccess")},
    {"phase", Cg2JsonString("publication")},
    {"result", Cg2ResultJson(result)},
    {"success", Cg2JsonBoolean(true)},
  }));
}

bool Cg2RunManifest(const V2Request& request, V2RunResult& result) {
  std::wstring rootWide;
  std::vector<std::wstring> rootComponents;
  std::string error;
  if (!Cg2ValidateRoot(request.rootAbsolutePath, rootWide, rootComponents, error)) {
    result.error = error; return false;
  }
  HANDLE root = INVALID_HANDLE_VALUE;
  V2Identity rootIdentity;
  if (!Cg2OpenRoot(rootWide, root, rootIdentity, error)) {
    result.error = error; return false;
  }
  std::vector<V2Tuple> tuples;
  std::vector<V2Captured> captures;
  std::vector<V2Projection> projections;
  std::vector<V2ManifestChunk> chunks;
  if (!Cg2CollectManifest(root, request.maxAggregateBytes, tuples, captures, projections, chunks, error)) {
    if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
    result.error = error; return false;
  }
  const std::string receipt = Cg2RequestReceipt(request);
  const std::string rootIdentityDigest = Cg2RootIdentity(rootIdentity);
  const std::string sessionId = Cg2SessionId(request, rootIdentityDigest);
  const std::string censusRecordsDigest = Cg2CensusRecordsDigest(tuples);
  const std::string snapshotId = Cg2SnapshotId(request, rootIdentityDigest, censusRecordsDigest);
  V2Session session{request.operation, receipt, rootIdentityDigest, sessionId, snapshotId};
  V2ProjectionResult projectionResult;
  if (!Cg2ProjectCaptured(session, tuples, captures, projections, projectionResult, error)) {
    if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
    result.error = error; return false;
  }
  const bool emitted = Cg2EmitManifestFrames(session, tuples, captures, projections, projectionResult);
  if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
  if (!emitted) {
    result.error = "PUBLICATION_PARTIAL_WRITE";
    return false;
  }
  result.ok = true;
  result.session = session;
  return true;
}

}  // namespace codegraph_source_policy_v2
