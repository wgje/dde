#include "codegraph-read-identity-v2-win32.hpp"

#include <bcrypt.h>
#include <winternl.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <cwctype>
#include <iomanip>
#include <limits>
#include <map>
#include <sstream>
#include <string_view>
#include <utility>

#pragma comment(lib, "bcrypt.lib")

namespace codegraph_source_policy_v2 {
std::string LowerAscii(std::string value);
namespace {

constexpr size_t kFileBufferBytes = 65536;
constexpr size_t kMaxPathCharacters = 32767;
constexpr ULONG kFileOpen = 1;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileSynchronousIoNonalert = 0x00000020;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;

using NtCreateFileFn = NTSTATUS(NTAPI*)(
  PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
  ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using RtlNtStatusToDosErrorFn = ULONG(WINAPI*)(NTSTATUS);

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { reset(); value = other.value; other.value = INVALID_HANDLE_VALUE; }
    return *this;
  }
  ~Handle() { reset(); }
  bool valid() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
  void reset(HANDLE next = INVALID_HANDLE_VALUE) {
    if (valid()) CloseHandle(value);
    value = next;
  }
  HANDLE release() {
    HANDLE out = value;
    value = INVALID_HANDLE_VALUE;
    return out;
  }
};

struct Snapshot {
  FILE_ID_INFO identity{};
  BY_HANDLE_FILE_INFORMATION basic{};
  uint64_t size = 0;
  uint64_t lastWriteTime = 0;
  uint64_t creationTime = 0;
};

struct FileInfo {
  V2Identity identity;
  uint64_t size = 0;
  uint64_t mtimeNs = 0;
  uint64_t ctimeNs = 0;
  uint64_t hardlinkCount = 0;
  bool reparse = false;
};

uint64_t Combine(DWORD high, DWORD low) {
  return (static_cast<uint64_t>(high) << 32) | low;
}

uint64_t FileTimeValue(const FILETIME& value) {
  return Combine(value.dwHighDateTime, value.dwLowDateTime);
}

bool TakeSnapshot(HANDLE handle, Snapshot& output) {
  if (!GetFileInformationByHandle(handle, &output.basic)) return false;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &output.identity, sizeof(output.identity))) return false;
  output.size = Combine(output.basic.nFileSizeHigh, output.basic.nFileSizeLow);
  output.lastWriteTime = FileTimeValue(output.basic.ftLastWriteTime);
  output.creationTime = FileTimeValue(output.basic.ftCreationTime);
  return true;
}

bool SameSnapshot(const Snapshot& left, const Snapshot& right) {
  return left.identity.VolumeSerialNumber == right.identity.VolumeSerialNumber
    && std::memcmp(left.identity.FileId.Identifier, right.identity.FileId.Identifier,
      sizeof(left.identity.FileId.Identifier)) == 0
    && left.size == right.size && left.lastWriteTime == right.lastWriteTime
    && left.creationTime == right.creationTime;
}

bool IsReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  return !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))
    || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

std::string MapOpenError(NTSTATUS status, RtlNtStatusToDosErrorFn toDosError) {
  ULONG error = toDosError ? toDosError(status) : ERROR_GEN_FAILURE;
  if (error == ERROR_ACCESS_DENIED) return "NATIVE_ACCESS_DENIED";
  if (error == ERROR_SHARING_VIOLATION) return "NATIVE_SHARING_VIOLATION";
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
    || error == ERROR_INVALID_NAME || error == ERROR_DIRECTORY) return "NATIVE_PATH_NOT_FOUND";
  return "NATIVE_READ_FAILED";
}

bool OpenRootHandle(const std::wstring& root, Handle& output, std::string& error) {
  Handle rootHandle(CreateFileW(
    root.c_str(),
    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    nullptr));
  if (!rootHandle.valid()) {
    error = "NATIVE_PATH_NOT_FOUND";
    return false;
  }
  if (IsReparsePoint(rootHandle.value)) {
    error = "NATIVE_REPARSE";
    return false;
  }
  output = std::move(rootHandle);
  return true;
}

bool OpenComponent(
  HANDLE parent,
  const std::wstring& component,
  bool intermediate,
  bool directory,
  Handle& output,
  std::string& error) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) { error = "NATIVE_READ_FAILED"; return false; }
  FARPROC createAddress = GetProcAddress(ntdll, "NtCreateFile");
  FARPROC errorAddress = GetProcAddress(ntdll, "RtlNtStatusToDosError");
  NtCreateFileFn createFile = nullptr;
  RtlNtStatusToDosErrorFn toDosError = nullptr;
  static_assert(sizeof(createFile) == sizeof(createAddress));
  static_assert(sizeof(toDosError) == sizeof(errorAddress));
  std::memcpy(&createFile, &createAddress, sizeof(createFile));
  std::memcpy(&toDosError, &errorAddress, sizeof(toDosError));
  if (!createFile) { error = "NATIVE_READ_FAILED"; return false; }
  UNICODE_STRING name{};
  name.Buffer = const_cast<PWSTR>(component.data());
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, parent, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE nextValue = INVALID_HANDLE_VALUE;
  ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  if (intermediate || directory) access |= FILE_LIST_DIRECTORY;
  else access |= FILE_GENERIC_READ;
  ULONG options = kFileOpenReparsePoint | kFileSynchronousIoNonalert;
  if (intermediate || directory) options |= kFileDirectoryFile;
  NTSTATUS status = createFile(
    &nextValue, access, &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen, options, nullptr, 0);
  if (status < 0) { error = MapOpenError(status, toDosError); return false; }
  Handle next(nextValue);
  if (IsReparsePoint(next.value)) { error = "NATIVE_REPARSE"; return false; }
  output = std::move(next);
  return true;
}

bool ValidUtf8(std::string_view value, std::wstring& wide) {
  if (value.empty() || value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return false;
  int count = MultiByteToWideChar(
    CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (count <= 0) return false;
  wide.resize(static_cast<size_t>(count));
  return MultiByteToWideChar(
    CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
    wide.data(), count) == count;
}

bool ValidComponent(std::wstring_view component) {
  if (component.empty() || component == L"." || component == L"..") return false;
  if (component.back() == L'.' || component.back() == L' ') return false;
  for (wchar_t character : component) {
    if (character < 0x20 || character == L'<' || character == L'>' || character == L':'
      || character == L'"' || character == L'/' || character == L'\\' || character == L'|'
      || character == L'?' || character == L'*') return false;
  }
  return true;
}

bool SplitComponents(
  std::wstring_view value,
  wchar_t separator,
  std::vector<std::wstring>& output) {
  size_t start = 0;
  while (start <= value.size()) {
    size_t end = value.find(separator, start);
    if (end == std::wstring_view::npos) end = value.size();
    std::wstring component(value.substr(start, end - start));
    if (!ValidComponent(component)) return false;
    output.push_back(std::move(component));
    if (end == value.size()) break;
    start = end + 1;
  }
  return true;
}

bool FileInfoFromSnapshot(const Snapshot& value, FileInfo& output) {
  output.identity.fileId = Cg2Hex(
    value.identity.FileId.Identifier,
    sizeof(value.identity.FileId.Identifier));
  std::ostringstream volume;
  volume << std::hex << std::setfill('0') << std::setw(16)
         << value.identity.VolumeSerialNumber;
  output.identity.volumeSerial = volume.str().substr(8);
  output.size = value.size;
  output.mtimeNs = value.lastWriteTime;
  output.ctimeNs = value.creationTime;
  output.hardlinkCount = value.basic.nNumberOfLinks;
  output.reparse = (value.basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  return true;
}

std::string Decimal(uint64_t value) {
  return std::to_string(value);
}

std::string StatTupleJson(const FileInfo& value) {
  return Cg2JsonObject({
    {"ctimeNs", Cg2JsonString(Decimal(value.ctimeNs))},
    {"hardlinkCount", Cg2JsonString(Decimal(value.hardlinkCount))},
    {"fileId", Cg2JsonString(value.identity.fileId)},
    {"mtimeNs", Cg2JsonString(Decimal(value.mtimeNs))},
    {"reparseState", Cg2JsonString(value.reparse ? "REPARSE" : "NOT_REPARSE")},
    {"size", Cg2JsonString(Decimal(value.size))},
    {"volumeSerial", Cg2JsonString(value.identity.volumeSerial)},
  });
}

std::string CanonicalString(std::string_view value) {
  return Cg2JsonString(value);
}

std::string CanonicalNumber(uint64_t value) {
  return std::to_string(value);
}

std::string CanonicalBoolean(bool value) {
  return value ? "true" : "false";
}

std::string CanonicalObject(std::vector<std::pair<std::string_view, std::string>> fields) {
  std::sort(fields.begin(), fields.end(), [](const auto& left, const auto& right) {
    return left.first < right.first;
  });
  std::string out = "{";
  for (size_t index = 0; index < fields.size(); ++index) {
    if (index) out.push_back(',');
    out += Cg2JsonString(fields[index].first);
    out.push_back(':');
    out += fields[index].second;
  }
  out.push_back('}');
  return out;
}

std::string CanonicalArray(const std::vector<std::string>& values) {
  std::string out = "[";
  for (size_t index = 0; index < values.size(); ++index) {
    if (index) out.push_back(',');
    out += values[index];
  }
  out.push_back(']');
  return out;
}

std::string Uint64Json(uint64_t value) {
  return std::to_string(value);
}

void AppendUint32(std::vector<unsigned char>& output, uint32_t value) {
  output.push_back(static_cast<unsigned char>(value >> 24));
  output.push_back(static_cast<unsigned char>(value >> 16));
  output.push_back(static_cast<unsigned char>(value >> 8));
  output.push_back(static_cast<unsigned char>(value));
}

void AppendUint64(std::vector<unsigned char>& output, uint64_t value) {
  for (int shift = 56; shift >= 0; shift -= 8) {
    output.push_back(static_cast<unsigned char>(value >> shift));
  }
}

std::vector<unsigned char> AsciiBytes(std::string_view value) {
  return std::vector<unsigned char>(value.begin(), value.end());
}

bool Sha256Internal(const std::vector<unsigned char>& value, std::string& output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
    return false;
  }
  bool ok = BCRYPT_SUCCESS(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0))
    && (value.empty()
      || BCRYPT_SUCCESS(BCryptHashData(hash, const_cast<PUCHAR>(value.data()),
        static_cast<ULONG>(value.size()), 0)));
  std::array<unsigned char, 32> digest{};
  if (ok) ok = BCRYPT_SUCCESS(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0));
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!ok) return false;
  output = Cg2Hex(digest.data(), digest.size());
  return true;
}

std::string WideToUtf8(std::wstring_view value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
    CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string output(static_cast<size_t>(size), '\0');
  const int written = WideCharToMultiByte(
    CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
    output.data(), size, nullptr, nullptr);
  if (written != size) return {};
  return output;
}

bool IsExcludedDirectoryName(std::wstring_view name) {
  static constexpr std::string_view kExcluded[] = {
    ".angular", ".cache", ".codegraph", ".feedback_images", ".git", ".gradle",
    ".next", ".nuxt", ".tmp", ".turbo", ".worktrees", "build", "cache",
    "coverage", "dist", "dist-ssr", "logs", "node_modules", "out",
    "playwright-report", "temp", "test-results", "tmp",
  };
  const std::string utf8 = WideToUtf8(name);
  std::string lower = LowerAscii(utf8);
  for (const std::string_view excluded : kExcluded) {
    if (lower == excluded) return true;
  }
  return false;
}

bool RootPathFromHandle(HANDLE handle, std::wstring& output) {
  const DWORD size = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED);
  if (size == 0) return false;
  output.resize(static_cast<size_t>(size));
  const DWORD written = GetFinalPathNameByHandleW(
    handle, output.data(), size, FILE_NAME_NORMALIZED);
  if (written == 0 || written >= size) return false;
  output.resize(static_cast<size_t>(written));
  return true;
}

std::string RelativePathFromComponents(const std::vector<std::wstring>& components) {
  std::string output;
  for (size_t index = 0; index < components.size(); ++index) {
    if (index) output.push_back('/');
    output += WideToUtf8(components[index]);
  }
  return output;
}

bool EndsWithOrdinalIgnoreCaseAscii(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size()
    && value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

}  // namespace

std::wstring ActualComponentName(HANDLE handle);
NTSTATUS NtCreateFileValue(
  HANDLE& output,
  ACCESS_MASK access,
  POBJECT_ATTRIBUTES attributes,
  PIO_STATUS_BLOCK ioStatus,
  PLARGE_INTEGER allocationSize,
  ULONG fileAttributes,
  ULONG shareAccess,
  ULONG createDisposition,
  ULONG createOptions,
  PVOID eaBuffer,
  ULONG eaLength);

V2StatTuple V2TupleFromInfo(const FileInfo& value);
std::string LowerAscii(std::string value);
bool LowerEndsWith(const std::string& value, const std::string& suffix);
std::string Cg2PolicyDefinitionDigest();
std::string Cg2PathSetDigest();

std::string Cg2EscapeJson(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('"');
  for (unsigned char byte : value) {
    switch (byte) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (byte < 0x20) {
          constexpr char kHex[] = "0123456789abcdef";
          out += "\\u00";
          out.push_back(kHex[(byte >> 4) & 0x0f]);
          out.push_back(kHex[byte & 0x0f]);
        } else {
          out.push_back(static_cast<char>(byte));
        }
    }
  }
  out.push_back('"');
  return out;
}

std::string Cg2JsonString(std::string_view value) {
  return Cg2EscapeJson(value);
}

std::string Cg2JsonBoolean(bool value) {
  return CanonicalBoolean(value);
}

std::string Cg2JsonObject(const std::vector<std::pair<std::string_view, std::string>>& fields) {
  return CanonicalObject(fields);
}

std::string Cg2JsonArray(const std::vector<std::string>& values) {
  return CanonicalArray(values);
}

std::string Cg2IdentityJson(const V2Identity& value) {
  return CanonicalObject({{"fileId", CanonicalString(value.fileId)},
                          {"volumeSerial", CanonicalString(value.volumeSerial)}});
}

std::string Cg2StatTupleJson(const V2StatTuple& value) {
  return CanonicalObject({
    {"ctimeNs", CanonicalString(value.ctimeNs)},
    {"hardlinkCount", CanonicalString(value.hardlinkCount)},
    {"fileId", CanonicalString(value.fileId)},
    {"mtimeNs", CanonicalString(value.mtimeNs)},
    {"reparseState", CanonicalString(value.reparseState)},
    {"size", CanonicalString(value.size)},
    {"volumeSerial", CanonicalString(value.volumeSerial)},
  });
}

std::string Cg2AttestationJson(const V2Attestation& value) {
  return CanonicalObject({
    {"after", Cg2StatTupleJson(value.after)},
    {"before", Cg2StatTupleJson(value.before)},
    {"oplock", CanonicalString(value.oplock)},
  });
}

std::string Cg2TupleJson(const V2Tuple& value) {
  return CanonicalObject({
    {"attestation", Cg2AttestationJson(value.attestation)},
    {"entryIndex", CanonicalString(value.entryIndex)},
    {"identity", Cg2IdentityJson(value.identity)},
    {"relativePath", CanonicalString(value.relativePath)},
    {"sha256", CanonicalString(value.sha256)},
    {"size", CanonicalString(value.size)},
  });
}

std::string Cg2CapturedJson(const V2Captured& value) {
  return CanonicalObject({
    {"attestation", Cg2AttestationJson(value.tuple.attestation)},
    {"entryIndex", CanonicalString(value.tuple.entryIndex)},
    {"identity", Cg2IdentityJson(value.tuple.identity)},
    {"relativePath", CanonicalString(value.tuple.relativePath)},
    {"sha256", CanonicalString(value.tuple.sha256)},
    {"size", CanonicalString(value.tuple.size)},
    {"decodedBytesBase64", CanonicalString(value.decodedBytesBase64)},
    {"decodedLength", CanonicalString(value.decodedLength)},
  });
}

std::string Cg2ProjectionJson(const V2Projection& value) {
  return CanonicalObject({
    {"class", CanonicalString(value.className)},
    {"entryIndex", CanonicalString(value.entryIndex)},
    {"path", CanonicalString(value.path)},
    {"role", CanonicalString(value.role)},
    {"sha256", CanonicalString(value.sha256)},
    {"size", CanonicalString(value.size)},
  });
}

std::string Cg2ResultJson(const V2ProjectionResult& value) {
  return CanonicalObject({
    {"aggregateRawBytes", CanonicalString(value.aggregateRawBytes)},
    {"capturedRawDigest", CanonicalString(value.capturedRawDigest)},
    {"contentDigest", CanonicalString(value.contentDigest)},
    {"entryCount", CanonicalString(value.entryCount)},
    {"finalCensusDigest", CanonicalString(value.finalCensusDigest)},
    {"finalProjectionCoreDigest", CanonicalString(value.finalProjectionCoreDigest)},
    {"initialCensusDigest", CanonicalString(value.initialCensusDigest)},
    {"metadataDigest", CanonicalString(value.metadataDigest)},
    {"pathSetDigest", CanonicalString(value.pathSetDigest)},
    {"sourcePolicyDigest", CanonicalString(value.sourcePolicyDigest)},
  });
}

std::string Cg2Hex(const unsigned char* data, size_t size) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t index = 0; index < size; ++index) {
    out.push_back(kHex[(data[index] >> 4) & 0x0f]);
    out.push_back(kHex[data[index] & 0x0f]);
  }
  return out;
}

std::string Cg2Sha256Bytes(const std::vector<unsigned char>& value) {
  std::string output;
  if (!Sha256Internal(value, output)) return std::string(64, '0');
  return output;
}

std::string Cg2Base64Url(const std::vector<unsigned char>& value) {
  static constexpr char kAlphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((value.size() + 2) / 3 * 4);
  for (size_t index = 0; index < value.size(); index += 3) {
    const uint32_t a = value[index];
    const uint32_t b = index + 1 < value.size() ? value[index + 1] : 0;
    const uint32_t c = index + 2 < value.size() ? value[index + 2] : 0;
    const uint32_t triple = (a << 16) | (b << 8) | c;
    out.push_back(kAlphabet[(triple >> 18) & 0x3f]);
    out.push_back(kAlphabet[(triple >> 12) & 0x3f]);
    if (index + 1 < value.size()) out.push_back(kAlphabet[(triple >> 6) & 0x3f]);
    if (index + 2 < value.size()) out.push_back(kAlphabet[triple & 0x3f]);
  }
  return out;
}

std::string Cg2FieldV3Digest(
  const std::vector<std::pair<std::string_view, std::vector<unsigned char>>>& fields) {
  std::vector<unsigned char> bytes = AsciiBytes(std::string_view("CG2F3\0", 6));
  AppendUint32(bytes, static_cast<uint32_t>(fields.size()));
  for (const auto& [name, value] : fields) {
    const std::vector<unsigned char> nameBytes = AsciiBytes(name);
    AppendUint32(bytes, static_cast<uint32_t>(nameBytes.size()));
    bytes.insert(bytes.end(), nameBytes.begin(), nameBytes.end());
    AppendUint64(bytes, value.size());
    bytes.insert(bytes.end(), value.begin(), value.end());
  }
  return Cg2Sha256Bytes(bytes);
}

std::string Cg2RootIdentity(const V2Identity& value) {
  return Cg2FieldV3Digest({
    {"domain", AsciiBytes("root-identity-v1")},
    {"fileId", AsciiBytes(value.fileId)},
    {"volumeSerial", AsciiBytes(value.volumeSerial)},
  });
}

std::string Cg2RequestReceipt(const V2Request& request) {
  std::vector<std::pair<std::string_view, std::string>> fields;
  fields.emplace_back("maxAggregateBytes", Uint64Json(request.maxAggregateBytes));
  fields.emplace_back("maxBytes", Uint64Json(request.maxBytes));
  fields.emplace_back("nonce", CanonicalString(request.nonce));
  fields.emplace_back("operation", CanonicalString(request.operation));
  fields.emplace_back("protocol", CanonicalString(request.protocol));
  fields.emplace_back("relativePath", CanonicalString(request.relativePath));
  fields.emplace_back("rootAbsolutePath", CanonicalString(request.rootAbsolutePath));
  std::sort(fields.begin(), fields.end(), [](const auto& left, const auto& right) {
    return left.first < right.first;
  });
  std::string body = "{";
  for (size_t index = 0; index < fields.size(); ++index) {
    if (index) body.push_back(',');
    body += CanonicalString(fields[index].first);
    body.push_back(':');
    body += fields[index].second;
  }
  body.push_back('}');
  return Cg2Sha256Bytes(AsciiBytes("CG2REQ1\0" + body));
}

std::string Cg2SessionId(const V2Request& request, const std::string& rootIdentity) {
  const std::string digest = Cg2FieldV3Digest({
    {"domain", AsciiBytes("session-id-v3")},
    {"nonce", AsciiBytes(request.nonce)},
    {"rootIdentity", AsciiBytes(rootIdentity)},
  });
  return digest.substr(0, 32);
}

std::string Cg2SnapshotId(
  const V2Request& request,
  const std::string& rootIdentity,
  const std::string& censusRecordsDigest) {
  const std::string digest = Cg2FieldV3Digest({
    {"domain", AsciiBytes("snapshot-id-v3")},
    {"nonce", AsciiBytes(request.nonce)},
    {"rootIdentity", AsciiBytes(rootIdentity)},
    {"initialCensusDigest", AsciiBytes(censusRecordsDigest)},
  });
  return digest.substr(0, 32);
}

bool Cg2WriteAll(std::string_view value) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  size_t offset = 0;
  while (offset < value.size()) {
    DWORD written = 0;
    const DWORD remaining = static_cast<DWORD>(std::min<size_t>(
      value.size() - offset, std::numeric_limits<DWORD>::max()));
    if (!WriteFile(output, value.data() + offset, remaining, &written, nullptr) || written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

bool Cg2EmitFrame(std::string_view body) {
  const uint64_t bodyBytes = static_cast<uint64_t>(body.size());
  const uint8_t prefix[8] = {
    static_cast<uint8_t>(bodyBytes >> 56), static_cast<uint8_t>(bodyBytes >> 48),
    static_cast<uint8_t>(bodyBytes >> 40), static_cast<uint8_t>(bodyBytes >> 32),
    static_cast<uint8_t>(bodyBytes >> 24), static_cast<uint8_t>(bodyBytes >> 16),
    static_cast<uint8_t>(bodyBytes >> 8), static_cast<uint8_t>(bodyBytes),
  };
  return Cg2WriteAll(std::string_view(reinterpret_cast<const char*>(prefix), sizeof(prefix)))
    && Cg2WriteAll(body)
    && Cg2WriteAll("\n");
}

std::string Cg2PreSessionError(std::string_view code) {
  return CanonicalObject({
    {"code", CanonicalString(code)},
    {"detail", CanonicalObject({
      {"expected", Cg2JsonString("null")},
      {"kind", CanonicalString("request")},
      {"nativeStatus", Cg2JsonString("null")},
      {"observed", Cg2JsonString("null")},
      {"pathToken", Cg2JsonString("null")},
    })},
    {"phase", CanonicalString("pre-session")},
    {"retryable", Cg2JsonBoolean(false)},
  });
}

std::string Cg2FrameCommon(const V2Session& session) {
  return CanonicalObject({
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)},
  });
}

std::string Cg2Frame(std::string_view kind, std::string_view phase,
  const V2Session& session, std::string body = {}) {
  (void)session;
  return CanonicalObject({{"kind", CanonicalString(kind)},
    {"phase", CanonicalString(phase)}, {"__body", body}});
}

bool Cg2EmitPreSessionError(std::string_view code) {
  return Cg2EmitFrame(CanonicalObject({
    {"kind", CanonicalString("finalError")},
    {"operation", CanonicalString("unknown")},
    {"phase", CanonicalString("pre-session")},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString("NONE")},
    {"rootIdentity", CanonicalString("NONE")},
    {"sessionId", CanonicalString("NONE")},
    {"snapshotId", CanonicalString("NONE")},
    {"success", Cg2JsonBoolean(false)},
    {"error", Cg2PreSessionError(code)},
  }));
}

bool Cg2EmitSessionError(const V2Session& session, std::string_view code) {
  const std::string error = Cg2PreSessionError(code);
  return Cg2EmitFrame(CanonicalObject({
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)},
    {"kind", CanonicalString("errorFrame")},
    {"phase", CanonicalString("read")},
    {"error", error},
  })) && Cg2EmitFrame(CanonicalObject({
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)},
    {"kind", CanonicalString("finalError")},
    {"phase", CanonicalString("read")},
    {"success", Cg2JsonBoolean(false)},
    {"error", error},
  }));
}

bool Cg2ParseRequest(std::string_view body, V2Request& request, std::string& error) {
  class RequestParser {
   public:
    explicit RequestParser(std::string_view input) : input_(input) {}
    bool Parse(V2Request& value) {
      std::vector<std::pair<std::string, std::string>> fields;
      if (!ParseObject(fields)) return false;
      std::map<std::string, std::string> values;
      for (const auto& field : fields) {
        if (!values.emplace(field.first, field.second).second) return false;
      }
      value.operation = values["operation"];
      value.nonce = values["nonce"];
      value.protocol = values["protocol"];
      value.rootAbsolutePath = values["rootAbsolutePath"];
      if (value.operation != "read" && value.operation != "manifest") return false;
      if (value.protocol != kProtocol || value.nonce.size() != 32) return false;
      if (!std::all_of(value.nonce.begin(), value.nonce.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
      })) return false;
      if (value.operation == "read") {
        value.relativePath = values["relativePath"];
        value.maxBytes = DecimalValue(values["maxBytes"]);
        return !value.relativePath.empty() && value.maxBytes > 0;
      }
      value.maxAggregateBytes = DecimalValue(values["maxAggregateBytes"]);
      return value.maxAggregateBytes > 0;
    }
   private:
    std::string_view input_;
    size_t position_ = 0;
    bool ParseObject(std::vector<std::pair<std::string, std::string>>& fields) {
      if (!Consume("{")) return false;
      while (true) {
        std::string name;
        if (!ParseString(name) || !Consume(":")) return false;
        std::string text;
        if (input_[position_] == '"') { if (!ParseString(text)) return false; }
        else if (!ParseNumber(text)) return false;
        fields.emplace_back(std::move(name), std::move(text));
        if (Consume("}")) return true;
        if (!Consume(",")) return false;
      }
    }
    bool Consume(std::string_view expected) {
      if (input_.substr(position_, expected.size()) != expected) return false;
      position_ += expected.size();
      return true;
    }
    bool ParseString(std::string& value) {
      if (!Consume("\"")) return false;
      value.clear();
      while (position_ < input_.size()) {
        const unsigned char c = static_cast<unsigned char>(input_[position_++]);
        if (c == '"') return true;
        if (c < 0x20) return false;
        if (c != '\\') { value.push_back(static_cast<char>(c)); continue; }
        if (position_ >= input_.size()) return false;
        const char escaped = input_[position_++];
        if (escaped == '"' || escaped == '\\') value.push_back(escaped);
        else return false;
      }
      return false;
    }
    bool ParseNumber(std::string& value) {
      const size_t start = position_;
      while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') {
        ++position_;
      }
      if (position_ == start) return false;
      value = std::string(input_.substr(start, position_ - start));
      return true;
    }
    static uint64_t DecimalValue(const std::string& value) {
      uint64_t result = 0;
      for (char c : value) {
        if (c < '0' || c > '9') return 0;
        result = result * 10 + static_cast<uint64_t>(c - '0');
      }
      return result;
    }
  };
  RequestParser parser(body);
  if (!parser.Parse(request)) { error = "ADAPTER_BAD_REQUEST"; return false; }
  return true;
}

bool Cg2ReadRequest(std::string& output) {
  std::string input;
  std::array<char, 4096> chunk{};
  while (true) {
    DWORD count = 0;
    const HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
    if (!ReadFile(stdinHandle, chunk.data(), static_cast<DWORD>(chunk.size()), &count, nullptr)) break;
    if (count == 0) break;
    input.append(chunk.data(), count);
    if (input.size() > kMaxRequestBytes + 1) { output.clear(); return false; }
  }
  if (input.empty() || input.back() != '\n') return false;
  input.pop_back();
  output = std::move(input);
  return output.size() <= kMaxRequestBytes;
}

bool Cg2OpenRoot(
  const std::wstring& root,
  HANDLE& handle,
  V2Identity& identity,
  std::string& error) {
  Handle rootHandle(CreateFileW(
    root.c_str(),
    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    nullptr));
  if (!rootHandle.valid()) { error = "NATIVE_PATH_NOT_FOUND"; return false; }
  Snapshot snapshot;
  if (!TakeSnapshot(rootHandle.value, snapshot)) { error = "NATIVE_READ_FAILED"; return false; }
  FileInfo info;
  if (!FileInfoFromSnapshot(snapshot, info) || info.reparse) {
    error = "NATIVE_REPARSE";
    return false;
  }
  identity = info.identity;
  handle = rootHandle.release();
  return true;
}

bool Cg2OpenComponents(
  HANDLE root,
  const std::vector<std::wstring>& components,
  bool directory,
  HANDLE& handle,
  std::string& error) {
  HANDLE parent = root;
  for (size_t index = 0; index < components.size(); ++index) {
    const std::wstring& component = components[index];
    UNICODE_STRING name{};
    name.Buffer = const_cast<PWSTR>(component.data());
    name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
    name.MaximumLength = name.Length;
    OBJECT_ATTRIBUTES attributes{};
    InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, parent, nullptr);
    IO_STATUS_BLOCK ioStatus{};
    HANDLE nextValue = INVALID_HANDLE_VALUE;
    const bool intermediate = index + 1 < components.size();
    ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if (intermediate) access |= FILE_LIST_DIRECTORY;
    else if (directory) access |= FILE_LIST_DIRECTORY;
    else access |= GENERIC_READ;
    ULONG options = kFileOpenReparsePoint | kFileSynchronousIoNonalert;
    if (intermediate || directory) options |= kFileDirectoryFile;
    NTSTATUS status = NtCreateFileValue(nextValue, access, &attributes, &ioStatus, nullptr,
      FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      kFileOpen, options, nullptr, 0);
    if (status < 0) { error = MapOpenError(status, nullptr); return false; }
    Handle next(nextValue);
    if (IsReparsePoint(next.value)) { error = "NATIVE_REPARSE"; return false; }
    std::wstring actual = ActualComponentName(next.value);
    if (actual != component) { error = "NATIVE_ALIAS_COLLISION"; return false; }
    parent = next.release();
  }
  handle = parent;
  return true;
}

std::wstring ActualComponentName(HANDLE handle) {
  std::vector<unsigned char> storage(sizeof(FILE_NAME_INFO) + 65536 * sizeof(wchar_t));
  auto* info = reinterpret_cast<FILE_NAME_INFO*>(storage.data());
  if (!GetFileInformationByHandleEx(handle, FileNameInfo, info,
    static_cast<DWORD>(storage.size()))) return {};
  std::wstring name(info->FileName, info->FileNameLength / sizeof(wchar_t));
  const size_t slash = name.find_last_of(L'\\');
  return slash == std::wstring::npos ? name : name.substr(slash + 1);
}

NTSTATUS NtCreateFileValue(
  HANDLE& output,
  ACCESS_MASK access,
  POBJECT_ATTRIBUTES attributes,
  PIO_STATUS_BLOCK ioStatus,
  PLARGE_INTEGER allocationSize,
  ULONG fileAttributes,
  ULONG shareAccess,
  ULONG createDisposition,
  ULONG createOptions,
  PVOID eaBuffer,
  ULONG eaLength) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return 0xC0000001L;
  FARPROC address = GetProcAddress(ntdll, "NtCreateFile");
  NtCreateFileFn createFile = nullptr;
  static_assert(sizeof(createFile) == sizeof(address));
  std::memcpy(&createFile, &address, sizeof(createFile));
  if (!createFile) return 0xC0000001L;
  return createFile(
    &output, access, attributes, ioStatus, allocationSize, fileAttributes, shareAccess,
    createDisposition, createOptions, eaBuffer, eaLength);
}

bool Cg2ValidateRoot(
  const std::string& root,
  std::wstring& wide,
  std::vector<std::wstring>&,
  std::string& error) {
  if (!ValidUtf8(root, wide) || wide.size() < 3 || wide[1] != L':' || wide[2] != L'\\') {
    error = "ADAPTER_BAD_REQUEST";
    return false;
  }
  return true;
}

bool Cg2ValidateRelative(
  const std::string& path,
  std::vector<std::wstring>& components,
  std::string& error) {
  std::wstring wide;
  if (!ValidUtf8(path, wide)) { error = "ADAPTER_BAD_REQUEST"; return false; }
  if (!SplitComponents(wide, L'/', components) || components.empty()) {
    error = "ADAPTER_BAD_REQUEST";
    return false;
  }
  return true;
}

bool Cg2ReadStable(
  HANDLE handle,
  uint64_t maxBytes,
  V2Captured& captured,
  std::string& error) {
  Snapshot before;
  if (!TakeSnapshot(handle, before)) { error = "NATIVE_READ_FAILED"; return false; }
  if ((before.basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    error = "NATIVE_PATH_NOT_REGULAR";
    return false;
  }
  if (before.basic.nNumberOfLinks != 1) { error = "NATIVE_HARDLINK"; return false; }
  if (before.size > maxBytes) {
    error = "FILE_TOO_LARGE";
    return false;
  }
  std::vector<unsigned char> bytes(static_cast<size_t>(before.size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD count = 0;
    const DWORD requested = static_cast<DWORD>(std::min<size_t>(65536, bytes.size() - offset));
    if (!ReadFile(handle, bytes.data() + offset, requested, &count, nullptr) || count == 0) {
      error = "NATIVE_READ_FAILED";
      return false;
    }
    offset += count;
  }
  Snapshot after;
  if (!TakeSnapshot(handle, after) || !SameSnapshot(before, after)) {
    error = "NATIVE_CENSUS_DRIFT";
    return false;
  }
  FileInfo info;
  FileInfoFromSnapshot(after, info);
  captured.tuple.attestation.before = V2TupleFromInfo(info);
  captured.tuple.attestation.after = V2TupleFromInfo(info);
  captured.tuple.attestation.oplock = "UNAVAILABLE_FAIL";
  captured.tuple.identity = info.identity;
  captured.tuple.size = std::to_string(info.size);
  captured.tuple.sha256 = Cg2Sha256Bytes(bytes);
  captured.decodedBytes = std::move(bytes);
  captured.decodedBytesBase64 = Cg2Base64Url(captured.decodedBytes);
  captured.decodedLength = captured.tuple.size;
  return true;
}

V2StatTuple V2TupleFromInfo(const FileInfo& value) {
  V2StatTuple tuple;
  tuple.ctimeNs = std::to_string(value.ctimeNs);
  tuple.hardlinkCount = std::to_string(value.hardlinkCount);
  tuple.fileId = value.identity.fileId;
  tuple.mtimeNs = std::to_string(value.mtimeNs);
  tuple.reparseState = "NOT_REPARSE";
  tuple.size = std::to_string(value.size);
  tuple.volumeSerial = value.identity.volumeSerial;
  return tuple;
}

void Cg2ClassifyPath(
  const std::string& relativePath, std::string& className, std::string& role) {
  const std::string lower = LowerAscii(relativePath);
  if (lower.find("node_modules/") != std::string::npos || lower.rfind(".git/", 0) == 0
    || lower.find("/.git/") != std::string::npos || lower.rfind("dist/", 0) == 0
    || lower.find("/dist/") != std::string::npos || lower.rfind("build/", 0) == 0
    || lower.find("/build/") != std::string::npos) {
    className = "EXCLUDE"; role = "NONE"; return;
  }
  if (LowerEndsWith(lower, ".ts") || LowerEndsWith(lower, ".tsx")) {
    className = "INCLUDE"; role = "TYPESCRIPT";
  } else if (LowerEndsWith(lower, ".js") || LowerEndsWith(lower, ".mjs")
    || LowerEndsWith(lower, ".cjs")) {
    className = "INCLUDE"; role = "JAVASCRIPT";
  } else if (LowerEndsWith(lower, ".json")) {
    className = "INCLUDE"; role = "SOURCE_POLICY_CONTRACT";
  } else if (LowerEndsWith(lower, ".html")) {
    className = "INCLUDE"; role = "ANGULAR_TEMPLATE";
  } else if (LowerEndsWith(lower, ".css") || LowerEndsWith(lower, ".scss")) {
    className = "INCLUDE"; role = "ANGULAR_STYLE";
  } else {
    className = "EXCLUDE"; role = "EXCLUDE_UNCLASSIFIED";
  }
}

std::string LowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

bool LowerEndsWith(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size()
    && value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string Cg2CensusRecordsDigest(const std::vector<V2Tuple>& tuples) {
  std::vector<std::string> rows;
  for (const V2Tuple& tuple : tuples) rows.push_back(Cg2TupleJson(tuple));
  return Cg2FieldV3Digest({{"domain", AsciiBytes("census-records-v3")},
    {"tuples", AsciiBytes(CanonicalArray(rows))}});
}

std::string Cg2InitialCensusDigest(
  const V2Session& session, const std::vector<V2Tuple>& tuples) {
  const std::string records = Cg2CensusRecordsDigest(tuples);
  return Cg2FieldV3Digest({{"domain", AsciiBytes("initial-census-v3")},
    {"rootIdentity", AsciiBytes(session.rootIdentity)},
    {"snapshotId", AsciiBytes(session.snapshotId)},
    {"censusRecordsDigest", AsciiBytes(records)}});
}

std::string Cg2FinalCensusDigest(
  const V2Session& session, const std::vector<V2Tuple>& tuples) {
  const std::string records = Cg2CensusRecordsDigest(tuples);
  return Cg2FieldV3Digest({{"domain", AsciiBytes("final-census-v3")},
    {"rootIdentity", AsciiBytes(session.rootIdentity)},
    {"snapshotId", AsciiBytes(session.snapshotId)},
    {"censusRecordsDigest", AsciiBytes(records)}});
}

std::string Cg2RawEntryDigest(const V2Captured& captured, const V2Session& session) {
  return Cg2FieldV3Digest({
    {"domain", AsciiBytes("raw-entry-v3")},
    {"rootIdentity", AsciiBytes(session.rootIdentity)},
    {"snapshotId", AsciiBytes(session.snapshotId)},
    {"sessionId", AsciiBytes(session.sessionId)},
    {"entryIndex", AsciiBytes(captured.tuple.entryIndex)},
    {"relativePath", AsciiBytes(captured.tuple.relativePath)},
    {"identity", AsciiBytes(Cg2IdentityJson(captured.tuple.identity))},
    {"attestation", AsciiBytes(Cg2AttestationJson(captured.tuple.attestation))},
    {"size", AsciiBytes(captured.tuple.size)},
    {"decodedBytes", captured.decodedBytes},
  });
}

std::string Cg2CapturedRawDigest(
  const V2Session& session,
  const std::vector<V2Captured>& captures,
  const std::vector<std::string>& rawDigests) {
  return Cg2FieldV3Digest({
    {"domain", AsciiBytes("captured-raw-v3")},
    {"rootIdentity", AsciiBytes(session.rootIdentity)},
    {"snapshotId", AsciiBytes(session.snapshotId)},
    {"sessionId", AsciiBytes(session.sessionId)},
    {"entryCount", AsciiBytes(std::to_string(captures.size()))},
    {"rawEntryDigests", AsciiBytes(CanonicalArray(rawDigests))},
  });
}

std::string Cg2MetadataDigest(
  const V2Session&,
  const std::vector<V2Captured>& captures) {
  std::vector<std::string> records;
  for (const V2Captured& entry : captures) {
    records.push_back(CanonicalObject({
      {"attestation", Cg2AttestationJson(entry.tuple.attestation)},
      {"entryIndex", CanonicalString(entry.tuple.entryIndex)},
      {"identity", Cg2IdentityJson(entry.tuple.identity)},
      {"relativePath", CanonicalString(entry.tuple.relativePath)},
      {"sha256", CanonicalString(entry.tuple.sha256)},
      {"size", CanonicalString(entry.tuple.size)},
    }));
  }
  return Cg2FieldV3Digest({{"domain", AsciiBytes("metadata-v3")},
    {"records", AsciiBytes(CanonicalArray(records))}});
}

std::string Cg2ContentDigest(
  const V2Session&,
  const std::vector<V2Captured>& captures,
  const std::vector<std::string>& rawDigests) {
  std::vector<std::string> records;
  for (size_t index = 0; index < captures.size(); ++index) {
    records.push_back(CanonicalObject({
      {"entryIndex", CanonicalString(captures[index].tuple.entryIndex)},
      {"relativePath", CanonicalString(captures[index].tuple.relativePath)},
      {"rawEntryDigest", CanonicalString(rawDigests[index])},
    }));
  }
  return Cg2FieldV3Digest({{"domain", AsciiBytes("content-v3")},
    {"records", AsciiBytes(CanonicalArray(records))}});
}

bool Cg2ProjectCaptured(
  const V2Session& session,
  const std::vector<V2Tuple>& tuples,
  const std::vector<V2Captured>& captures,
  const std::vector<V2Projection>& projections,
  V2ProjectionResult& result,
  std::string& error) {
  if (tuples.size() != captures.size() || captures.size() != projections.size()) {
    error = "SOURCE_POLICY_COVERAGE"; return false;
  }
  std::vector<std::string> rawDigests;
  std::vector<std::string> coreEntries;
  uint64_t aggregate = 0;
  for (size_t index = 0; index < captures.size(); ++index) {
    if (Cg2TupleJson(tuples[index]) != Cg2TupleJson(captures[index].tuple)) {
      error = "SOURCE_POLICY_COVERAGE"; return false;
    }
    rawDigests.push_back(Cg2RawEntryDigest(captures[index], session));
    aggregate += captures[index].decodedBytes.size();
    coreEntries.push_back(Cg2ProjectionJson(projections[index]));
  }
  const std::string capturedRawDigest = Cg2CapturedRawDigest(session, captures, rawDigests);
  const std::string metadataDigest = Cg2MetadataDigest(session, captures);
  const std::string contentDigest = Cg2ContentDigest(session, captures, rawDigests);
  const std::string policyDefinitionDigest = Cg2PolicyDefinitionDigest();
  const std::string pathSetDigest = Cg2PathSetDigest();
  const std::string core = CanonicalObject({
    {"entries", CanonicalArray(coreEntries)},
    {"policyDefinitionDigest", CanonicalString(policyDefinitionDigest)},
  });
  const std::string finalProjectionCoreDigest = Cg2FieldV3Digest({
    {"domain", AsciiBytes("final-projection-core-v3")},
    {"capturedRawDigest", AsciiBytes(capturedRawDigest)},
    {"contentDigest", AsciiBytes(contentDigest)},
    {"metadataDigest", AsciiBytes(metadataDigest)},
    {"policyDefinitionDigest", AsciiBytes(policyDefinitionDigest)},
    {"pathSetDigest", AsciiBytes(pathSetDigest)},
    {"finalProjectionCore", AsciiBytes(core)},
  });
  const std::string sourcePolicyDigest = Cg2FieldV3Digest({
    {"domain", AsciiBytes("source-policy-v3")},
    {"policyDefinitionDigest", AsciiBytes(policyDefinitionDigest)},
    {"pathSetDigest", AsciiBytes(pathSetDigest)},
    {"finalProjectionCoreDigest", AsciiBytes(finalProjectionCoreDigest)},
  });
  result.aggregateRawBytes = std::to_string(aggregate);
  result.capturedRawDigest = capturedRawDigest;
  result.contentDigest = contentDigest;
  result.entryCount = std::to_string(captures.size());
  result.finalCensusDigest = Cg2FinalCensusDigest(session, tuples);
  result.finalProjectionCoreDigest = finalProjectionCoreDigest;
  result.initialCensusDigest = Cg2InitialCensusDigest(session, tuples);
  result.metadataDigest = metadataDigest;
  result.pathSetDigest = pathSetDigest;
  result.sourcePolicyDigest = sourcePolicyDigest;
  return true;
}

std::string Cg2PolicyDefinitionDigest() {
  return std::string(CODEGRAPH_READ_IDENTITY_V2_POLICY_DEFINITION_DIGEST);
}

std::string Cg2PathSetDigest() {
  return std::string(CODEGRAPH_READ_IDENTITY_V2_PATH_SET_DIGEST);
}

std::string Cg2ChunkDigest(const V2Session& session, const V2ManifestChunk& chunk) {
  std::vector<std::string> items;
  for (const V2Tuple& tuple : chunk.items) items.push_back(Cg2TupleJson(tuple));
  return Cg2FieldV3Digest({
    {"domain", AsciiBytes("chunk-v3")},
    {"rootIdentity", AsciiBytes(session.rootIdentity)},
    {"snapshotId", AsciiBytes(session.snapshotId)},
    {"sessionId", AsciiBytes(session.sessionId)},
    {"chunkIndex", AsciiBytes(chunk.chunkIndex)},
    {"chunkCount", AsciiBytes(chunk.chunkCount)},
    {"cursorBefore", AsciiBytes(chunk.cursorBefore)},
    {"cursorAfter", AsciiBytes(chunk.cursorAfter)},
    {"items", AsciiBytes(CanonicalArray(items))},
  });
}

bool Cg2CollectManifest(
  HANDLE root,
  uint64_t maxAggregateBytes,
  std::vector<V2Tuple>& tuples,
  std::vector<V2Captured>& captures,
  std::vector<V2Projection>& projections,
  std::vector<V2ManifestChunk>& chunks,
  std::string& error) {
  struct Frame { std::wstring relativeWide; };
  std::vector<Frame> stack;
  stack.push_back({L""});
  std::vector<std::string> seenFolded;
  uint64_t aggregate = 0;
  while (!stack.empty()) {
    const Frame frame = std::move(stack.back());
    stack.pop_back();
    std::wstring searchRoot;
    if (!RootPathFromHandle(root, searchRoot)) {
      error = "NATIVE_READ_FAILED"; return false;
    }
    if (searchRoot.size() > 1 && searchRoot.back() == L'\\') searchRoot.pop_back();
    const std::wstring search = frame.relativeWide.empty()
      ? searchRoot + L"\\*"
      : searchRoot + L"\\" + frame.relativeWide + L"\\*" ;
    WIN32_FIND_DATAW data{};
    HANDLE find = FindFirstFileW(search.c_str(), &data);
    if (find == INVALID_HANDLE_VALUE) continue;
    do {
      const std::wstring name = data.cFileName;
      if (name == L"." || name == L"..") continue;
      if ((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        error = "NATIVE_REPARSE";
        FindClose(find);
        return false;
      }
      if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        if (IsExcludedDirectoryName(name)) continue;
        if (frame.relativeWide.size() + name.size() + 1 > kMaxPathUtf8Bytes * 2) {
          error = "SOURCE_POLICY_LIMIT";
          FindClose(find);
          return false;
        }
        stack.push_back({frame.relativeWide.empty()
          ? name
          : frame.relativeWide + L"\\" + name});
        continue;
      }
      std::vector<std::wstring> components;
      const std::wstring full = frame.relativeWide.empty()
        ? name
        : frame.relativeWide + L"\\" + name;
      size_t start = 0;
      while (start <= full.size()) {
        const size_t end = full.find(L'\\', start);
        const std::wstring component = end == std::wstring::npos
          ? full.substr(start)
          : full.substr(start, end - start);
        if (component.empty()) { error = "SOURCE_POLICY_PATH_INVALID"; FindClose(find); return false; }
        components.push_back(component);
        if (end == std::wstring::npos) break;
        start = end + 1;
      }
      const std::string relativePath = RelativePathFromComponents(components);
      if (relativePath.empty() || relativePath.size() > kMaxPathUtf8Bytes) {
        error = "SOURCE_POLICY_LIMIT";
        FindClose(find);
        return false;
      }
      const std::string lower = LowerAscii(relativePath);
      if (EndsWithOrdinalIgnoreCaseAscii(relativePath, ".bak")
        || EndsWithOrdinalIgnoreCaseAscii(relativePath, ".log")
        || EndsWithOrdinalIgnoreCaseAscii(relativePath, ".map")
        || EndsWithOrdinalIgnoreCaseAscii(relativePath, ".swp")
        || EndsWithOrdinalIgnoreCaseAscii(relativePath, ".temp")
        || EndsWithOrdinalIgnoreCaseAscii(relativePath, ".tmp")
        || EndsWithOrdinalIgnoreCaseAscii(relativePath, ".tsbuildinfo")
        || lower.find("node_modules/") != std::string::npos
        || lower.rfind(".git/", 0) == 0 || lower.find("/.git/") != std::string::npos
        || lower.rfind("dist/", 0) == 0 || lower.find("/dist/") != std::string::npos
        || lower.rfind("build/", 0) == 0 || lower.find("/build/") != std::string::npos) {
        continue;
      }
      if (std::find(seenFolded.begin(), seenFolded.end(), lower) != seenFolded.end()) {
        error = "SOURCE_POLICY_PATH_DUPLICATE";
        FindClose(find);
        return false;
      }
      seenFolded.push_back(lower);
      Handle file;
      if (!Cg2OpenComponents(root, components, false, file.value, error)) {
        FindClose(find);
        return false;
      }
      V2Captured captured;
      if (!Cg2ReadStable(file.value, kMaxEntryBytes, captured, error)) {
        FindClose(find);
        return false;
      }
      captured.tuple.entryIndex = std::to_string(captures.size());
      captured.tuple.relativePath = relativePath;
      V2Projection projection;
      Cg2ClassifyPath(relativePath, projection.className, projection.role);
      projection.entryIndex = captured.tuple.entryIndex;
      projection.path = relativePath;
      projection.sha256 = captured.tuple.sha256;
      projection.size = captured.tuple.size;
      tuples.push_back(captured.tuple);
      captures.push_back(std::move(captured));
      projections.push_back(std::move(projection));
      aggregate += static_cast<uint64_t>(captures.back().decodedBytes.size());
      if (aggregate > maxAggregateBytes || captures.size() > kMaxCapturedFrames) {
        error = "SOURCE_POLICY_LIMIT";
        FindClose(find);
        return false;
      }
    } while (FindNextFileW(find, &data));
    FindClose(find);
  }
  chunks.clear();
  return true;
}

bool Cg2EmitReadFrames(
  const V2Session& session,
  const V2Captured& captured,
  const V2Projection& projection,
  const V2ProjectionResult& result) {
  const std::vector<V2Tuple> tuples{captured.tuple};
  const std::vector<V2Captured> captures{captured};
  const std::vector<V2Projection> projections{projection};
  if (!Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("start")}, {"phase", CanonicalString("census")},
    {"chunkCount", CanonicalNumber(0)}, {"entryCount", CanonicalNumber(1)},
    {"initialCensusDigest", CanonicalString(result.initialCensusDigest)},
    {"pathSetDigest", CanonicalString(result.pathSetDigest)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}))) return false;
  if (!Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("initialCensus")}, {"phase", CanonicalString("census")},
    {"entryIndex", CanonicalString("0")}, {"censusTuple", Cg2TupleJson(captured.tuple)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}))) return false;
  if (!Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("captured")}, {"phase", CanonicalString("read")},
    {"capturedEntry", Cg2CapturedJson(captured)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}))) return false;
  if (!Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("finalCensus")}, {"phase", CanonicalString("attestation")},
    {"entryIndex", CanonicalString("0")}, {"censusTuple", Cg2TupleJson(captured.tuple)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}))) return false;
  if (!Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("projection")}, {"phase", CanonicalString("source-policy")},
    {"projectionEntry", Cg2ProjectionJson(projection)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}))) return false;
  if (!Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("end")}, {"phase", CanonicalString("attestation")},
    {"aggregateRawBytes", CanonicalString(result.aggregateRawBytes)},
    {"capturedRawDigest", CanonicalString(result.capturedRawDigest)},
    {"contentDigest", CanonicalString(result.contentDigest)},
    {"entryCount", CanonicalString(result.entryCount)},
    {"finalCensusDigest", CanonicalString(result.finalCensusDigest)},
    {"finalProjectionCoreDigest", CanonicalString(result.finalProjectionCoreDigest)},
    {"initialCensusDigest", CanonicalString(result.initialCensusDigest)},
    {"metadataDigest", CanonicalString(result.metadataDigest)},
    {"pathSetDigest", CanonicalString(result.pathSetDigest)},
    {"sourcePolicyDigest", CanonicalString(result.sourcePolicyDigest)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}))) return false;
  return Cg2EmitFrame(CanonicalObject({{"kind", CanonicalString("finalSuccess")}, {"phase", CanonicalString("publication")},
    {"result", Cg2ResultJson(result)}, {"success", CanonicalBoolean(true)},
    {"operation", CanonicalString(session.operation)},
    {"protocol", CanonicalString(kProtocol)},
    {"receiptSha256", CanonicalString(session.receiptSha256)},
    {"rootIdentity", CanonicalString(session.rootIdentity)},
    {"sessionId", CanonicalString(session.sessionId)},
    {"snapshotId", CanonicalString(session.snapshotId)}}));
}

bool Cg2RunRead(const V2Request& request, V2RunResult& result) {
  std::wstring rootWide;
  std::vector<std::wstring> rootComponents;
  std::vector<std::wstring> relativeComponents;
  std::string error;
  if (!Cg2ValidateRoot(request.rootAbsolutePath, rootWide, rootComponents, error)
    || !Cg2ValidateRelative(request.relativePath, relativeComponents, error)) {
    result.error = error; return false;
  }
  Handle root;
  V2Identity rootIdentity;
  if (!Cg2OpenRoot(rootWide, root.value, rootIdentity, error)) { result.error = error; return false; }
  Handle target;
  if (!Cg2OpenComponents(root.value, relativeComponents, false, target.value, error)) {
    result.error = error; return false;
  }
  V2Captured captured;
  if (!Cg2ReadStable(target.value, request.maxBytes, captured, error)) {
    result.error = error; return false;
  }
  captured.tuple.entryIndex = "0";
  captured.tuple.relativePath = request.relativePath;
  const std::string receipt = Cg2RequestReceipt(request);
  const std::string rootIdentityDigest = Cg2RootIdentity(rootIdentity);
  const std::string sessionId = Cg2SessionId(request, rootIdentityDigest);
  const std::vector<V2Tuple> tuples{captured.tuple};
  const std::string censusRecordsDigest = Cg2CensusRecordsDigest(tuples);
  const std::string snapshotId = Cg2SnapshotId(request, rootIdentityDigest, censusRecordsDigest);
  V2Session session{request.operation, receipt, rootIdentityDigest, sessionId, snapshotId};
  V2Projection projection;
  Cg2ClassifyPath(request.relativePath, projection.className, projection.role);
  projection.entryIndex = "0"; projection.path = request.relativePath;
  projection.sha256 = captured.tuple.sha256; projection.size = captured.tuple.size;
  V2ProjectionResult projectionResult;
  if (!Cg2ProjectCaptured(session, tuples, {captured}, {projection}, projectionResult, error)) {
    result.error = error; return false;
  }
  if (!Cg2EmitReadFrames(session, captured, projection, projectionResult)) {
    result.error = "PUBLICATION_PARTIAL_WRITE"; return false;
  }
  result.ok = true;
  result.session = session;
  return true;
}

}  // namespace codegraph_source_policy_v2
