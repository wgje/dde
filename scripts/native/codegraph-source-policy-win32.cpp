#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00

#include <windows.h>

#include "codegraph-read-identity-v2-win32.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace codegraph_source_policy_v2 {

bool IsAsciiDigit(unsigned char byte) {
  return byte >= '0' && byte <= '9';
}

bool IsLowerHex(std::string_view value, size_t count) {
  return value.size() == count && std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return (byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f');
  });
}

bool IsCanonicalDecimal(std::string_view value, uint64_t maximum) {
  if (value.empty()) return false;
  if (value.size() > 1 && value.front() == '0') return false;
  uint64_t parsed = 0;
  for (unsigned char byte : value) {
    if (!IsAsciiDigit(byte)) return false;
    const uint64_t digit = static_cast<uint64_t>(byte - '0');
    if (parsed > (maximum - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  return true;
}

bool IsSafeJsonDepth(std::string_view value) {
  int depth = 0;
  int nodes = 0;
  bool inString = false;
  bool escaped = false;
  for (unsigned char byte : value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte == '\\') {
        escaped = true;
      } else if (byte == '"') {
        inString = false;
      }
      continue;
    }
    if (byte == '"') {
      inString = true;
    } else if (byte == '{' || byte == '[') {
      if (++depth > 100) return false;
      ++nodes;
    } else if (byte == '}' || byte == ']') {
      if (--depth < 0) return false;
    } else if (byte != ' ' && byte != '\t' && byte != '\r' && byte != '\n'
      && byte != ':' && byte != ',' && byte != '-' && byte != '+' && byte != '.'
      && byte != 'e' && byte != 'E' && !IsAsciiDigit(byte)) {
      return false;
    }
    if (nodes > 51015) return false;
  }
  return !inString && depth == 0;
}

std::string SafeNonce(std::string_view nonce) {
  return IsLowerHex(nonce, 32) ? std::string(nonce) : std::string(32, '0');
}

std::string EscapeJsonString(std::string_view value) {
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

std::string ErrorJson(std::string_view nonce, std::string_view code) {
  return "{\"error\":\"" + EscapeJsonString(code) + "\",\"nonce\":\"" + EscapeJsonString(SafeNonce(nonce))
    + "\",\"ok\":false,\"protocol\":\"" + std::string(kProtocol) + "\"}";
}

bool EmitJson(std::string_view value) {
  if (value.size() > kMaxFrameBodyBytes) return false;
  const uint64_t bodyBytes = static_cast<uint64_t>(value.size());
  const uint8_t prefix[8] = {
    static_cast<uint8_t>(bodyBytes),
    static_cast<uint8_t>(bodyBytes >> 8),
    static_cast<uint8_t>(bodyBytes >> 16),
    static_cast<uint8_t>(bodyBytes >> 24),
    static_cast<uint8_t>(bodyBytes >> 32),
    static_cast<uint8_t>(bodyBytes >> 40),
    static_cast<uint8_t>(bodyBytes >> 48),
    static_cast<uint8_t>(bodyBytes >> 56),
  };
  if (std::fwrite(prefix, 1, sizeof(prefix), stdout) != sizeof(prefix)) return false;
  if (!value.empty() && std::fwrite(value.data(), 1, value.size(), stdout) != value.size()) return false;
  return std::fputc('\n', stdout) == '\n';
}

struct Request {
  std::string operation;
  std::string nonce;
  std::string protocol;
  std::string rootAbsolutePath;
  std::string relativePath;
  uint64_t maxBytes = 0;
  uint64_t maxAggregateBytes = 0;
};

bool IsValidRelativePath(std::string_view value) {
  if (value.empty() || value.size() > kMaxPathUtf8Bytes || value.front() == '/' || value.back() == '/') {
    return false;
  }
  size_t components = 0;
  size_t start = 0;
  while (start < value.size()) {
    const size_t end = value.find('/', start);
    const size_t length = (end == std::string_view::npos ? value.size() : end) - start;
    const std::string_view component = value.substr(start, length);
    if (component.empty() || component == "." || component == ".." || component.size() > kMaxComponentUtf8Bytes) {
      return false;
    }
    for (const unsigned char byte : component) {
      if (byte == 0 || byte == '\\') return false;
    }
    if (++components > kMaxComponents) return false;
    if (end == std::string_view::npos) break;
    start = end + 1;
  }
  return true;
}

class RequestParser {
 public:
  explicit RequestParser(std::string_view body) : body_(body) {}

  bool Parse(Request& request) {
    std::vector<Field> fields;
    if (!ParseObject(fields)) return false;
    std::vector<std::string> names;
    for (const Field& field : fields) names.push_back(field.name);
    std::sort(names.begin(), names.end());
    if (std::adjacent_find(names.begin(), names.end()) != names.end()) return false;
    const Field* operation = Find(fields, "operation");
    const Field* nonce = Find(fields, "nonce");
    const Field* protocol = Find(fields, "protocol");
    const Field* root = Find(fields, "rootAbsolutePath");
    if (!operation || !nonce || !protocol || !root) return false;
    if (operation->isNumber || nonce->isNumber || protocol->isNumber || root->isNumber) return false;
    request.operation = operation->text;
    request.nonce = nonce->text;
    request.protocol = protocol->text;
    request.rootAbsolutePath = root->text;
    if (request.protocol != kProtocol || !IsLowerHex(request.nonce, 32)
      || request.rootAbsolutePath.empty() || request.rootAbsolutePath.size() > 32767) return false;
    if (request.operation == "read") {
      const Field* relativePath = Find(fields, "relativePath");
      const Field* maxBytes = Find(fields, "maxBytes");
      if (!relativePath || !maxBytes || maxBytes->isNumber == false) return false;
      request.relativePath = relativePath->text;
      request.maxBytes = maxBytes->number;
      return IsValidRelativePath(request.relativePath)
        && request.maxBytes <= kMaxEntryBytes && !Find(fields, "maxAggregateBytes");
    }
    if (request.operation == "manifest") {
      const Field* maxAggregateBytes = Find(fields, "maxAggregateBytes");
      if (!maxAggregateBytes || maxAggregateBytes->isNumber == false) return false;
      request.maxAggregateBytes = maxAggregateBytes->number;
      return request.maxAggregateBytes <= kMaxAggregateBytes
        && !Find(fields, "maxBytes") && !Find(fields, "relativePath");
    }
    return false;
  }

 private:
  struct Field {
    std::string name;
    std::string text;
    uint64_t number = 0;
    bool isNumber = false;
  };

  std::string_view body_;
  size_t position_ = 0;

  bool SkipWhitespace() {
    while (position_ < body_.size() && (body_[position_] == ' ' || body_[position_] == '\t')) {
      ++position_;
    }
    return position_ < body_.size();
  }

  bool ParseObject(std::vector<Field>& fields) {
    if (!SkipWhitespace() || body_[position_++] != '{') return false;
    if (!SkipWhitespace()) return false;
    if (body_[position_] == '}') {
      ++position_;
      return position_ == body_.size();
    }
    while (true) {
      Field field;
      if (!ParseString(field.name) || !SkipWhitespace() || body_[position_++] != ':') return false;
      if (!SkipWhitespace()) return false;
      if (body_[position_] == '"') {
        if (!ParseString(field.text)) return false;
      } else if (IsAsciiDigit(static_cast<unsigned char>(body_[position_]))) {
        if (!ParseNumber(field.number)) return false;
        field.isNumber = true;
      } else {
        return false;
      }
      fields.push_back(std::move(field));
      if (!SkipWhitespace()) return false;
      if (body_[position_] == ',') {
        ++position_;
        if (!SkipWhitespace()) return false;
        continue;
      }
      if (body_[position_] == '}') {
        ++position_;
        return position_ == body_.size();
      }
      return false;
    }
  }

  bool ParseString(std::string& value) {
    if (position_ >= body_.size() || body_[position_++] != '"') return false;
    value.clear();
    bool escaped = false;
    while (position_ < body_.size()) {
      const unsigned char byte = static_cast<unsigned char>(body_[position_++]);
      if (escaped) {
        if (byte == 'u') {
          if (position_ + 4 > body_.size()) return false;
          position_ += 4;
        } else if (byte != '"' && byte != '\\' && byte != '/' && byte != 'b' && byte != 'f'
          && byte != 'n' && byte != 'r' && byte != 't') {
          return false;
        }
        value.push_back(static_cast<char>(byte));
        escaped = false;
        continue;
      }
      if (byte == '\\') {
        escaped = true;
        continue;
      }
      if (byte == '"') return true;
      if (byte < 0x20) return false;
      value.push_back(static_cast<char>(byte));
    }
    return false;
  }

  bool ParseNumber(uint64_t& value) {
    const size_t start = position_;
    while (position_ < body_.size() && IsAsciiDigit(static_cast<unsigned char>(body_[position_]))) {
      ++position_;
    }
    const std::string_view digits = body_.substr(start, position_ - start);
    if (!IsCanonicalDecimal(digits, kMaxAggregateBytes)) return false;
    value = static_cast<uint64_t>(std::strtoull(std::string(digits).c_str(), nullptr, 10));
    return true;
  }

  static const Field* Find(const std::vector<Field>& fields, const char* name) {
    for (const Field& field : fields) {
      if (field.name == name) return &field;
    }
    return nullptr;
  }
};

bool readRequestBytes(std::string& output) {
  char buffer[16384];
  size_t total = 0;
  while (total <= kMaxRequestBytes + 1) {
    const size_t read = std::fread(buffer, 1, sizeof(buffer), stdin);
    if (read == 0) break;
    output.append(buffer, read);
    total += read;
    if (output.size() > kMaxRequestBytes + 1) return false;
  }
  if (output.empty()) return false;
  if (output.back() == '\n') output.pop_back();
  return output.size() <= kMaxRequestBytes && output.find('\n') == std::string::npos;
}

int MainImpl() {
  std::string input;
  if (!readRequestBytes(input)) {
    std::fputs(ErrorJson("", "ADAPTER_BAD_REQUEST").c_str(), stderr);
    return 0;
  }
  if (!IsSafeJsonDepth(input)) {
    std::fputs(ErrorJson("", "ADAPTER_BAD_REQUEST").c_str(), stderr);
    return 0;
  }
  Request request;
  if (!RequestParser(input).Parse(request)) {
    std::fputs(ErrorJson(request.nonce, "ADAPTER_BAD_REQUEST").c_str(), stderr);
    return 0;
  }
  codegraph_source_policy_v2::V2Request v2Request;
  v2Request.operation = request.operation;
  v2Request.nonce = request.nonce;
  v2Request.protocol = request.protocol;
  v2Request.rootAbsolutePath = request.rootAbsolutePath;
  v2Request.relativePath = request.relativePath;
  v2Request.maxBytes = request.maxBytes;
  v2Request.maxAggregateBytes = request.maxAggregateBytes;

  codegraph_source_policy_v2::V2RunResult result;
  const bool ok = request.operation == "manifest"
    ? codegraph_source_policy_v2::Cg2RunManifest(v2Request, result)
    : codegraph_source_policy_v2::Cg2RunRead(v2Request, result);
  if (!ok) {
    std::fputs(ErrorJson(request.nonce, result.error.empty()
      ? "NATIVE_READ_FAILED" : result.error).c_str(), stderr);
    return 1;
  }
  return 0;
}

}  // namespace codegraph_source_policy_v2

int main() {
  return codegraph_source_policy_v2::MainImpl();
}
