#ifndef CODEGRAPH_READ_IDENTITY_V2_WIN32_HPP
#define CODEGRAPH_READ_IDENTITY_V2_WIN32_HPP

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00

#include <windows.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifndef CODEGRAPH_READ_IDENTITY_V2_POLICY_DEFINITION_DIGEST
#error CODEGRAPH_READ_IDENTITY_V2_POLICY_DEFINITION_DIGEST is required
#endif
#ifndef CODEGRAPH_READ_IDENTITY_V2_PATH_SET_DIGEST
#error CODEGRAPH_READ_IDENTITY_V2_PATH_SET_DIGEST is required
#endif

namespace codegraph_source_policy_v2 {

constexpr std::string_view kProtocol = "CG2/2.8";
constexpr uint64_t kMaxRequestBytes = 65536;
constexpr uint64_t kMaxAggregateBytes = 134217728;
constexpr uint64_t kMaxEntryBytes = 100632000;
constexpr uint64_t kMaxFrameBodyBytes = 134217728;
constexpr uint64_t kMaxCapturedFrames = 2048;
constexpr uint64_t kMaxChunkElements = 12750;
constexpr size_t kMaxComponents = 100;
constexpr size_t kMaxComponentUtf8Bytes = 255;
constexpr size_t kMaxPathUtf8Bytes = 32760;
constexpr const char* kSourcePolicyV2Token = "codegraph-source-policy-v2";

struct V2Identity {
  std::string fileId;
  std::string volumeSerial;
};

struct V2StatTuple {
  std::string ctimeNs;
  std::string hardlinkCount;
  std::string fileId;
  std::string mtimeNs;
  std::string reparseState;
  std::string size;
  std::string volumeSerial;
};

struct V2Attestation {
  V2StatTuple before;
  V2StatTuple after;
  std::string oplock;
};

struct V2Tuple {
  std::string entryIndex;
  std::string relativePath;
  std::string sha256;
  std::string size;
  V2Identity identity;
  V2Attestation attestation;
};

struct V2Captured {
  V2Tuple tuple;
  std::vector<unsigned char> decodedBytes;
  std::string decodedBytesBase64;
  std::string decodedLength;
};

struct V2Projection {
  std::string className;
  std::string entryIndex;
  std::string path;
  std::string role;
  std::string sha256;
  std::string size;
};

struct V2Request {
  std::string operation;
  std::string nonce;
  std::string protocol;
  std::string rootAbsolutePath;
  std::string relativePath;
  uint64_t maxBytes = 0;
  uint64_t maxAggregateBytes = 0;
};

struct V2Session {
  std::string operation;
  std::string receiptSha256;
  std::string rootIdentity;
  std::string sessionId;
  std::string snapshotId;
};

struct V2ProjectionResult {
  std::string aggregateRawBytes;
  std::string capturedRawDigest;
  std::string contentDigest;
  std::string entryCount;
  std::string finalCensusDigest;
  std::string finalProjectionCoreDigest;
  std::string initialCensusDigest;
  std::string metadataDigest;
  std::string pathSetDigest;
  std::string sourcePolicyDigest;
};

struct V2RunResult {
  bool ok = false;
  std::string error;
  V2Session session;
};

struct V2ManifestChunk {
  std::string chunkIndex;
  std::string chunkCount;
  std::string cursorBefore;
  std::string cursorAfter;
  std::vector<V2Tuple> items;
  std::string chunkDigest;
};

std::string Cg2EscapeJson(std::string_view value);
std::string Cg2JsonString(std::string_view value);
std::string Cg2JsonBoolean(bool value);
std::string Cg2JsonObject(const std::vector<std::pair<std::string_view, std::string>>& fields);
std::string Cg2JsonArray(const std::vector<std::string>& values);
std::string Cg2IdentityJson(const V2Identity& value);
std::string Cg2StatTupleJson(const V2StatTuple& value);
std::string Cg2AttestationJson(const V2Attestation& value);
std::string Cg2TupleJson(const V2Tuple& value);
std::string Cg2CapturedJson(const V2Captured& value);
std::string Cg2ProjectionJson(const V2Projection& value);
std::string Cg2ResultJson(const V2ProjectionResult& value);
std::string Cg2Sha256Bytes(const std::vector<unsigned char>& value);
std::string Cg2Hex(const unsigned char* data, size_t size);
std::string Cg2Base64Url(const std::vector<unsigned char>& value);
std::string Cg2FieldV3Digest(
  const std::vector<std::pair<std::string_view, std::vector<unsigned char>>>& fields);
std::string Cg2RootIdentity(const V2Identity& value);
std::string Cg2RequestReceipt(const V2Request& request);
std::string Cg2SessionId(const V2Request& request, const std::string& rootIdentity);
std::string Cg2SnapshotId(
  const V2Request& request,
  const std::string& rootIdentity,
  const std::string& censusRecordsDigest);
bool Cg2WriteAll(std::string_view value);
bool Cg2EmitFrame(std::string_view body);
bool Cg2ReadRequest(std::string& output);
bool Cg2ParseRequest(std::string_view body, V2Request& request, std::string& error);
bool Cg2ValidateRoot(
  const std::string& root,
  std::wstring& wide,
  std::vector<std::wstring>& components,
  std::string& error);
bool Cg2ValidateRelative(
  const std::string& path,
  std::vector<std::wstring>& components,
  std::string& error);
bool Cg2OpenRoot(
  const std::wstring& root,
  HANDLE& handle,
  V2Identity& identity,
  std::string& error);
bool Cg2OpenComponents(
  HANDLE root,
  const std::vector<std::wstring>& components,
  bool directory,
  HANDLE& handle,
  std::string& error);
bool Cg2ReadStable(
  HANDLE handle,
  uint64_t maxBytes,
  V2Captured& captured,
  std::string& error);
void Cg2ClassifyPath(
  const std::string& relativePath, std::string& className, std::string& role);
std::string Cg2CensusRecordsDigest(const std::vector<V2Tuple>& tuples);
std::string Cg2InitialCensusDigest(
  const V2Session& session, const std::vector<V2Tuple>& tuples);
std::string Cg2FinalCensusDigest(
  const V2Session& session, const std::vector<V2Tuple>& tuples);
std::string Cg2RawEntryDigest(const V2Captured& captured, const V2Session& session);
bool Cg2ProjectCaptured(
  const V2Session& session,
  const std::vector<V2Tuple>& tuples,
  const std::vector<V2Captured>& captures,
  const std::vector<V2Projection>& projections,
  V2ProjectionResult& result,
  std::string& error);
bool Cg2EmitReadFrames(
  const V2Session& session,
  const V2Captured& captured,
  const V2Projection& projection,
  const V2ProjectionResult& result);
bool Cg2EmitManifestFrames(
  const V2Session& session,
  const std::vector<V2Tuple>& tuples,
  const std::vector<V2Captured>& captures,
  const std::vector<V2Projection>& projections,
  const V2ProjectionResult& result);
bool Cg2EmitPreSessionError(std::string_view code);
bool Cg2EmitSessionError(
  const V2Session& session, std::string_view code);
bool Cg2RunRead(const V2Request& request, V2RunResult& result);
bool Cg2CollectManifest(
  HANDLE root,
  uint64_t maxAggregateBytes,
  std::vector<V2Tuple>& tuples,
  std::vector<V2Captured>& captures,
  std::vector<V2Projection>& projections,
  std::vector<V2ManifestChunk>& chunks,
  std::string& error);
std::string Cg2ChunkDigest(const V2Session& session, const V2ManifestChunk& chunk);
bool Cg2RunManifest(const V2Request& request, V2RunResult& result);

}  // namespace codegraph_source_policy_v2
#endif
