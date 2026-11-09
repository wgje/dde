#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <bcrypt.h>
#include <winternl.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

#ifndef READ_IDENTITY_BUILD_ID
#error READ_IDENTITY_BUILD_ID is required
#endif
#ifndef READ_IDENTITY_PROTOCOL_SHA256
#error READ_IDENTITY_PROTOCOL_SHA256 is required
#endif
#ifndef READ_IDENTITY_SOURCE_SHA256
#error READ_IDENTITY_SOURCE_SHA256 is required
#endif

namespace {

constexpr std::string_view kProtocol = "codegraph-read-identity-v1";
constexpr size_t kMaxRequestBytes = 8192;
constexpr uint64_t kMaxFileBytes = 67108864;
constexpr size_t kMaxPathCharacters = 32767;
constexpr size_t kMaxComponents = 256;
constexpr ULONG kFileOpen = 1;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileSynchronousIoNonalert = 0x00000020;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;

constexpr const char* kBuildId = READ_IDENTITY_BUILD_ID;
constexpr const char* kProtocolSha256 = READ_IDENTITY_PROTOCOL_SHA256;
constexpr const char* kSourceSha256 = READ_IDENTITY_SOURCE_SHA256;

using NtCreateFileFn = NTSTATUS(NTAPI*)(
  PHANDLE,
  ACCESS_MASK,
  POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK,
  PLARGE_INTEGER,
  ULONG,
  ULONG,
  ULONG,
  ULONG,
  PVOID,
  ULONG);
using RtlNtStatusToDosErrorFn = ULONG(WINAPI*)(NTSTATUS);

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;

  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) {
    other.value = INVALID_HANDLE_VALUE;
  }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) {
      reset();
      value = other.value;
      other.value = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  ~Handle() { reset(); }

  bool valid() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
  void reset(HANDLE next = INVALID_HANDLE_VALUE) {
    if (valid()) CloseHandle(value);
    value = next;
  }
};

struct Request {
  uint64_t maxBytes = 0;
  std::string nonce;
  std::string relativePath;
  std::string root;
};

struct Snapshot {
  FILE_ID_INFO identity{};
  BY_HANDLE_FILE_INFORMATION basic{};
  uint64_t size = 0;
  uint64_t lastWriteTime = 0;
};

struct ReadEvidence {
  Snapshot snapshot;
  std::vector<unsigned char> bytes;
  std::string sha256;
};

bool writeAll(std::string_view value) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  size_t offset = 0;
  while (offset < value.size()) {
    DWORD written = 0;
    DWORD remaining = static_cast<DWORD>(std::min<size_t>(
      value.size() - offset,
      std::numeric_limits<DWORD>::max()));
    if (!WriteFile(output, value.data() + offset, remaining, &written, nullptr) || written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

std::string safeNonce(std::string_view nonce) {
  bool valid = nonce.size() == 32
    && std::all_of(nonce.begin(), nonce.end(), [](unsigned char value) {
      return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
    });
  return valid ? std::string(nonce) : std::string(32, '0');
}

std::string errorJson(std::string_view nonce, std::string_view error) {
  return std::string("{\"error\":\"") + std::string(error)
    + "\",\"nonce\":\"" + safeNonce(nonce)
    + "\",\"ok\":false,\"protocol\":\"" + std::string(kProtocol) + "\"}";
}

int fail(std::string_view nonce, std::string_view error) {
  writeAll(errorJson(nonce, error));
  return 0;
}

bool readRequestBytes(std::string& output) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::array<char, 1024> chunk{};
  while (true) {
    DWORD count = 0;
    if (!ReadFile(input, chunk.data(), static_cast<DWORD>(chunk.size()), &count, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE && !output.empty()) break;
      return false;
    }
    if (count == 0) break;
    output.append(chunk.data(), count);
    if (output.size() > kMaxRequestBytes + 1) return false;
  }
  if (output.empty() || output.back() != '\n') return false;
  output.pop_back();
  return output.size() <= kMaxRequestBytes && output.find_first_of("\r\n") == std::string::npos;
}

class RequestParser {
 public:
  explicit RequestParser(std::string_view input) : input_(input) {}

  bool parse(Request& request) {
    return consume("{\"maxBytes\":")
      && parseUnsigned(request.maxBytes)
      && consume(",\"nonce\":")
      && parseString(request.nonce)
      && consume(",\"operation\":\"read\",\"protocol\":\"codegraph-read-identity-v1\",\"relativePath\":")
      && parseString(request.relativePath)
      && consume(",\"root\":")
      && parseString(request.root)
      && consume("}")
      && position_ == input_.size();
  }

 private:
  std::string_view input_;
  size_t position_ = 0;

  bool consume(std::string_view expected) {
    if (input_.substr(position_, expected.size()) != expected) return false;
    position_ += expected.size();
    return true;
  }

  bool parseUnsigned(uint64_t& value) {
    if (position_ >= input_.size() || !std::isdigit(static_cast<unsigned char>(input_[position_]))) return false;
    if (input_[position_] == '0' && position_ + 1 < input_.size()
      && std::isdigit(static_cast<unsigned char>(input_[position_ + 1]))) return false;
    value = 0;
    while (position_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[position_]))) {
      unsigned digit = static_cast<unsigned>(input_[position_] - '0');
      if (value > (std::numeric_limits<uint64_t>::max() - digit) / 10) return false;
      value = value * 10 + digit;
      ++position_;
    }
    return true;
  }

  bool parseString(std::string& value) {
    if (position_ >= input_.size() || input_[position_++] != '"') return false;
    value.clear();
    while (position_ < input_.size()) {
      unsigned char character = static_cast<unsigned char>(input_[position_++]);
      if (character == '"') return true;
      if (character < 0x20) return false;
      if (character != '\\') {
        value.push_back(static_cast<char>(character));
        continue;
      }
      if (position_ >= input_.size()) return false;
      char escaped = input_[position_++];
      if (escaped == '"' || escaped == '\\') value.push_back(escaped);
      else return false;
    }
    return false;
  }
};

bool validUtf8(std::string_view value, std::wstring& wide) {
  if (value.empty() || value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return false;
  int count = MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    nullptr,
    0);
  if (count <= 0) return false;
  wide.resize(static_cast<size_t>(count));
  return MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    wide.data(),
    count) == count;
}

bool reservedDeviceName(std::wstring_view component) {
  size_t dot = component.find(L'.');
  std::wstring stem(component.substr(0, dot));
  std::transform(stem.begin(), stem.end(), stem.begin(), [](wchar_t value) {
    return static_cast<wchar_t>(towupper(value));
  });
  if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL") return true;
  if (stem.size() == 4 && (stem.rfind(L"COM", 0) == 0 || stem.rfind(L"LPT", 0) == 0)) {
    return stem[3] >= L'1' && stem[3] <= L'9';
  }
  return false;
}

bool validComponent(std::wstring_view component) {
  if (component.empty() || component == L"." || component == L"..") return false;
  if (component.back() == L'.' || component.back() == L' ') return false;
  for (wchar_t character : component) {
    if (character < 0x20 || character == L'<' || character == L'>' || character == L':'
      || character == L'"' || character == L'/' || character == L'\\'
      || character == L'|' || character == L'?' || character == L'*') return false;
  }
  return !reservedDeviceName(component);
}

bool splitComponents(std::wstring_view value, wchar_t separator, std::vector<std::wstring>& output) {
  size_t start = 0;
  while (start <= value.size()) {
    size_t end = value.find(separator, start);
    if (end == std::wstring_view::npos) end = value.size();
    std::wstring component(value.substr(start, end - start));
    if (!validComponent(component)) return false;
    output.push_back(std::move(component));
    if (end == value.size()) break;
    start = end + 1;
  }
  return true;
}

bool validateRequest(
  const Request& request,
  wchar_t& drive,
  std::vector<std::wstring>& components,
  std::string_view& error) {
  if (request.maxBytes == 0 || request.maxBytes > kMaxFileBytes
    || safeNonce(request.nonce) != request.nonce) {
    error = "INVALID_REQUEST";
    return false;
  }
  std::wstring root;
  std::wstring relative;
  if (!validUtf8(request.root, root) || !validUtf8(request.relativePath, relative)
    || root.size() > kMaxPathCharacters || relative.size() > kMaxPathCharacters) {
    error = "INVALID_REQUEST";
    return false;
  }
  if (root.size() < 3 || !iswalpha(root[0]) || root[1] != L':' || root[2] != L'\\'
    || root.find(L'/') != std::wstring::npos || relative.find(L'\\') != std::wstring::npos) {
    error = "INVALID_ROOT";
    return false;
  }
  drive = static_cast<wchar_t>(towupper(root[0]));
  if (root.size() > 3 && !splitComponents(std::wstring_view(root).substr(3), L'\\', components)) {
    error = "INVALID_ROOT";
    return false;
  }
  if (relative.empty() || !splitComponents(relative, L'/', components)
    || components.empty() || components.size() > kMaxComponents) {
    error = "INVALID_PATH";
    return false;
  }
  return true;
}

std::wstring actualComponentName(HANDLE handle) {
  std::vector<unsigned char> storage(sizeof(FILE_NAME_INFO) + 65536 * sizeof(wchar_t));
  auto* info = reinterpret_cast<FILE_NAME_INFO*>(storage.data());
  if (!GetFileInformationByHandleEx(
    handle,
    FileNameInfo,
    info,
    static_cast<DWORD>(storage.size()))) return {};
  std::wstring name(info->FileName, info->FileNameLength / sizeof(wchar_t));
  size_t slash = name.find_last_of(L'\\');
  return slash == std::wstring::npos ? name : name.substr(slash + 1);
}

bool isReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  return !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))
    || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

std::string mapOpenError(NTSTATUS status, RtlNtStatusToDosErrorFn toDosError) {
  ULONG error = toDosError ? toDosError(status) : ERROR_GEN_FAILURE;
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
    || error == ERROR_INVALID_NAME || error == ERROR_DIRECTORY) return "PATH_NOT_FOUND";
  return "FILE_READ_FAILED";
}

bool openTarget(
  wchar_t drive,
  const std::vector<std::wstring>& components,
  Handle& target,
  std::string& error) {
  std::wstring volume = L"\\\\?\\";
  volume.push_back(drive);
  volume += L":\\";
  Handle current(CreateFileW(
    volume.c_str(),
    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    nullptr));
  if (!current.valid()) {
    error = "INVALID_ROOT";
    return false;
  }
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) {
    error = "FILE_READ_FAILED";
    return false;
  }
  FARPROC ntCreateFileAddress = GetProcAddress(ntdll, "NtCreateFile");
  FARPROC toDosErrorAddress = GetProcAddress(ntdll, "RtlNtStatusToDosError");
  NtCreateFileFn ntCreateFile = nullptr;
  RtlNtStatusToDosErrorFn toDosError = nullptr;
  static_assert(sizeof(ntCreateFile) == sizeof(ntCreateFileAddress));
  static_assert(sizeof(toDosError) == sizeof(toDosErrorAddress));
  std::memcpy(&ntCreateFile, &ntCreateFileAddress, sizeof(ntCreateFile));
  std::memcpy(&toDosError, &toDosErrorAddress, sizeof(toDosError));
  if (!ntCreateFile) {
    error = "FILE_READ_FAILED";
    return false;
  }
  for (size_t index = 0; index < components.size(); ++index) {
    const std::wstring& component = components[index];
    UNICODE_STRING name{};
    name.Buffer = const_cast<PWSTR>(component.data());
    name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
    name.MaximumLength = name.Length;
    OBJECT_ATTRIBUTES attributes{};
    InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, current.value, nullptr);
    IO_STATUS_BLOCK ioStatus{};
    HANDLE nextValue = INVALID_HANDLE_VALUE;
    bool intermediate = index + 1 < components.size();
    ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if (intermediate) access |= FILE_LIST_DIRECTORY;
    else access |= GENERIC_READ;
    ULONG options = kFileOpenReparsePoint | kFileSynchronousIoNonalert;
    if (intermediate) options |= kFileDirectoryFile;
    NTSTATUS status = ntCreateFile(
      &nextValue,
      access,
      &attributes,
      &ioStatus,
      nullptr,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      kFileOpen,
      options,
      nullptr,
      0);
    if (status < 0) {
      error = mapOpenError(status, toDosError);
      return false;
    }
    Handle next(nextValue);
    if (isReparsePoint(next.value)) {
      error = "PATH_REPARSE";
      return false;
    }
    std::wstring actual = actualComponentName(next.value);
    if (actual.empty()) {
      error = "FILE_READ_FAILED";
      return false;
    }
    if (actual != component) {
      error = "PATH_CASE_MISMATCH";
      return false;
    }
    current = std::move(next);
  }
  target = std::move(current);
  return true;
}

uint64_t combine(DWORD high, DWORD low) {
  return (static_cast<uint64_t>(high) << 32) | low;
}

uint64_t fileTimeValue(const FILETIME& value) {
  return combine(value.dwHighDateTime, value.dwLowDateTime);
}

bool snapshot(HANDLE handle, Snapshot& output) {
  if (!GetFileInformationByHandle(handle, &output.basic)) return false;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &output.identity, sizeof(output.identity))) return false;
  output.size = combine(output.basic.nFileSizeHigh, output.basic.nFileSizeLow);
  output.lastWriteTime = fileTimeValue(output.basic.ftLastWriteTime);
  return true;
}

bool sameSnapshot(const Snapshot& left, const Snapshot& right) {
  return left.identity.VolumeSerialNumber == right.identity.VolumeSerialNumber
    && std::equal(
      std::begin(left.identity.FileId.Identifier),
      std::end(left.identity.FileId.Identifier),
      std::begin(right.identity.FileId.Identifier))
    && left.size == right.size
    && left.lastWriteTime == right.lastWriteTime;
}

std::string bytesToHex(const unsigned char* bytes, size_t size) {
  std::ostringstream output;
  output << std::hex << std::setfill('0');
  for (size_t index = 0; index < size; ++index) output << std::setw(2) << static_cast<unsigned>(bytes[index]);
  return output.str();
}

bool hashSha256(const std::vector<unsigned char>& bytes, std::string& output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD objectSize = 0;
  DWORD hashSize = 0;
  DWORD resultSize = 0;
  bool ok = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize),
    sizeof(objectSize), &resultSize, 0) < 0) goto cleanup;
  if (BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hashSize),
    sizeof(hashSize), &resultSize, 0) < 0 || hashSize != 32) goto cleanup;
  {
    std::vector<unsigned char> object(objectSize);
    std::array<unsigned char, 32> digest{};
    if (BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0) < 0) goto cleanup;
    if (!bytes.empty() && BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()),
      static_cast<ULONG>(bytes.size()), 0) < 0) goto cleanup;
    if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) goto cleanup;
    output = bytesToHex(digest.data(), digest.size());
    ok = true;
  }
cleanup:
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return ok;
}

bool readStable(HANDLE handle, uint64_t maxBytes, ReadEvidence& evidence, std::string& error) {
  if (GetFileType(handle) != FILE_TYPE_DISK || !snapshot(handle, evidence.snapshot)) {
    error = "FILE_READ_FAILED";
    return false;
  }
  if ((evidence.snapshot.basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    error = "PATH_NOT_REGULAR";
    return false;
  }
  if (evidence.snapshot.basic.nNumberOfLinks != 1) {
    error = "PATH_HARDLINK";
    return false;
  }
  if (evidence.snapshot.size > maxBytes || evidence.snapshot.size > kMaxFileBytes) {
    error = "FILE_TOO_LARGE";
    return false;
  }
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(handle, start, nullptr, FILE_BEGIN)) {
    error = "FILE_READ_FAILED";
    return false;
  }
  evidence.bytes.resize(static_cast<size_t>(evidence.snapshot.size));
  size_t offset = 0;
  while (offset < evidence.bytes.size()) {
    DWORD count = 0;
    DWORD requested = static_cast<DWORD>(std::min<size_t>(65536, evidence.bytes.size() - offset));
    if (!ReadFile(handle, evidence.bytes.data() + offset, requested, &count, nullptr) || count == 0) {
      error = "FILE_READ_FAILED";
      return false;
    }
    offset += count;
  }
  Snapshot after{};
  if (!snapshot(handle, after) || !sameSnapshot(evidence.snapshot, after)) {
    error = "FILE_DRIFT";
    return false;
  }
  if (!hashSha256(evidence.bytes, evidence.sha256)) {
    error = "FILE_READ_FAILED";
    return false;
  }
  return true;
}

bool readCurrentImage(ReadEvidence& imageEvidence, std::string& error) {
  std::vector<wchar_t> imagePath(kMaxPathCharacters + 1);
  DWORD length = GetModuleFileNameW(
    nullptr,
    imagePath.data(),
    static_cast<DWORD>(imagePath.size()));
  if (length == 0 || length >= static_cast<DWORD>(imagePath.size())) {
    error = "FILE_READ_FAILED";
    return false;
  }
  Handle image(CreateFileW(
    imagePath.data(),
    GENERIC_READ | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ,
    nullptr,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr));
  if (!image.valid()) {
    error = "FILE_READ_FAILED";
    return false;
  }
  return readStable(image.value, kMaxFileBytes, imageEvidence, error);
}

std::string base64(const std::vector<unsigned char>& bytes) {
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((bytes.size() + 2) / 3) * 4);
  for (size_t index = 0; index < bytes.size(); index += 3) {
    uint32_t value = static_cast<uint32_t>(bytes[index]) << 16;
    if (index + 1 < bytes.size()) value |= static_cast<uint32_t>(bytes[index + 1]) << 8;
    if (index + 2 < bytes.size()) value |= bytes[index + 2];
    output.push_back(alphabet[(value >> 18) & 63]);
    output.push_back(alphabet[(value >> 12) & 63]);
    output.push_back(index + 1 < bytes.size() ? alphabet[(value >> 6) & 63] : '=');
    output.push_back(index + 2 < bytes.size() ? alphabet[value & 63] : '=');
  }
  return output;
}

std::string identityJson(const FILE_ID_INFO& identity) {
  std::ostringstream volume;
  volume << std::hex << std::setfill('0') << std::setw(16) << identity.VolumeSerialNumber;
  return std::string("{\"fileId\":\"") + bytesToHex(
    identity.FileId.Identifier,
    sizeof(identity.FileId.Identifier))
    + "\",\"volumeSerial\":\"" + volume.str() + "\"}";
}

std::string successJson(
  const Request& request,
  const ReadEvidence& evidence,
  const ReadEvidence& imageEvidence) {
  return std::string("{\"attestation\":{\"binaryIdentity\":")
    + identityJson(imageEvidence.snapshot.identity)
    + ",\"binarySha256\":\"" + imageEvidence.sha256
    + "\",\"buildId\":\"" + kBuildId
    + "\",\"protocolSha256\":\"" + kProtocolSha256
    + "\",\"sourceSha256\":\"" + kSourceSha256
    + "\"},\"bytesBase64\":\"" + base64(evidence.bytes)
    + "\",\"identity\":" + identityJson(evidence.snapshot.identity)
    + ",\"lastWriteTime\":\"" + std::to_string(evidence.snapshot.lastWriteTime)
    + "\",\"nonce\":\"" + request.nonce
    + "\",\"ok\":true,\"protocol\":\"" + std::string(kProtocol)
    + "\",\"sha256\":\"" + evidence.sha256
    + "\",\"size\":" + std::to_string(evidence.snapshot.size) + "}";
}

}  // namespace

int main() {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  std::string input;
  Request request;
  if (!readRequestBytes(input) || !RequestParser(input).parse(request)) {
    return fail(std::string(32, '0'), "INVALID_REQUEST");
  }
  wchar_t drive = 0;
  std::vector<std::wstring> components;
  std::string_view validationError;
  if (!validateRequest(request, drive, components, validationError)) {
    return fail(request.nonce, validationError);
  }
  ReadEvidence imageEvidence;
  std::string error;
  if (!readCurrentImage(imageEvidence, error)) return fail(request.nonce, error);
  Handle target;
  if (!openTarget(drive, components, target, error)) return fail(request.nonce, error);
  ReadEvidence evidence;
  if (!readStable(target.value, request.maxBytes, evidence, error)) return fail(request.nonce, error);
  return writeAll(successJson(request, evidence, imageEvidence)) ? 0 : 1;
}
