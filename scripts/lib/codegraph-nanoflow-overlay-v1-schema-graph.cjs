'use strict';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
const OBJECT_RULES = [
  ["graph",["edges","nodes","schemaVersion"],[["schemaVersion","nodes","edges"]]],
  ["graph.edges[]",["column","kind","line","metadata","provenance","source","target"],[["kind","source","target","line","column","metadata"],["kind","source","target","line","metadata"],["kind","source","target","line","provenance","metadata"],["kind","source","target","metadata"]]],
["graph.edges[].metadata",["action","actions","alias","angularProperty","annotationName","annotationQualifiedName","api","argNames","arguments","attribute","attributeValue","binding","bindingKind","bootstrapComponent","bootstrapLine","bucket","call","callName","categories","category","channelName","channelVariable","className","column","columns","command","componentType","concurrently","configKey","configObject","configPath","configProperty","constraintName","constraintSource",
    "constraintType","constructorParameter","cursor","cursorKeyword","data","declarationType","deferrable","deps","docPath","element","endLine","envVar","event","events","excludeElements","exportName","exported","expression","field","filter","framework","functionName","grantOption","grantOptionFor","guardKind","header","host","importedName","indexMethod","indexName","initially","injectionKind","inputs","invokeName","isConst","isMutable","isTypeOnly","keyword","keywordMapping","kind","language","legacyRelation",
    "manifestFile","matchType","matchedNeedle","materialized","memberName","method","methodName","methodSource","normalizedHeader","notValid","nullsDistinct","objectName","objectNames","objectType","onDelete","onDeleteColumns","onUpdate","onUpdateColumns","operator","optionKeys","outputs","owner","ownerHeading","ownerName","packageName","parameterName","parentConfigPath","path","pathMatch","payloadKeys","permission","pipeName","policy","predicate","privilege","privileges","propertyName","provider","providerKind","publication","query",
    "queryType","queryValue","question","rawName","receiver","redirectTo","referencedColumns","referencedTable","registeredAt","relation","requiredBy","resolverKey","resourceName","resourceType","returnType","revokeBehavior","riskSource","riskTag","role","roles","rule","schema","scheme","security","selectConfig","selectSource","selector","sourceFile","sourcePath","status","storageSource","synthesizedBy","table","target","targetName","templateFile","testMapping","timing","trigger",
    "type","typeName","typeParameter","typeRole","unique","useClass","usingIndex","value","via","view","wildcard","writeOperation"],[["framework","relation","angularProperty","legacyRelation"],["relation","action","objectType","objectName","privileges","roles","grantOption"],["relation","action","objectType","objectName","privileges","roles","grantOptionFor"],["relation","action","owner","channelVariable"],["relation","action","privilege",
    "objectType","objectName","role","grantOption"],["relation","action","privilege","objectType","objectName","role","grantOptionFor"],["relation","action","role","privileges","objectType","objectNames","grantOption"],["relation","action","role","privileges","objectType","objectNames","grantOptionFor"],["relation","action"],["relation","annotationName","annotationQualifiedName"],["relation","api","attribute","value","kind"],["relation","api",
    "binding","expression","kind"],["relation","api","binding"],["relation","api","event"],["relation","api"],["relation","bindingKind","binding","matchedNeedle"],["relation","bindingKind","binding","templateFile","matchedNeedle"],["relation","bindingKind","matchedNeedle"],["relation","bindingKind","templateFile","matchedNeedle"],["relation","bucket","storageSource","policy","table"],["relation","bucket","storageSource"],["relation","callName",
    "receiver"],["relation","callName"],["relation","category","docPath"],["relation","category"],["relation","channelName","owner"],["relation","componentType","className","permission"],["relation","componentType","className","rawName","exported","actions"],["relation","componentType","className","resourceType","resourceName","manifestFile"],["relation","configKey","configObject","configProperty","configPath"],["relation","configObject","configPath",
    "configProperty"],["relation","configObject","configPath","parentConfigPath","configProperty"],["relation","constraintName","table","constraintType","constraintSource","columns","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","referencedTable","referencedColumns",
    "onDelete","notValid"],["relation","constraintName","table","constraintType","constraintSource","expression","notValid"],["relation","constraintName","table","constraintType","constraintSource","usingIndex","notValid"],["relation","constraintName","table"],["relation","envVar"],["relation","exportName","isTypeOnly"],["relation","exportName","targetName"],["relation","exportName"],["relation","field","table","requiredBy"],["relation","field",
    "table","selectConfig"],["relation","field","table","selectSource"],["relation","functionName","argNames"],["relation","functionName","returnType","language","security"],["relation","functionName","returnType","language"],["relation","functionName","returnType","security"],["relation","functionName","returnType"],["relation","functionName"],["relation","guardKind","path"],["relation","header","normalizedHeader","sourceFile"],["relation",
    "importedName","isTypeOnly"],["relation","importedName","target","packageName","wildcard"],["relation","importedName","alias","target","packageName","wildcard"],["relation","importedName"],["relation","indexName","table","columns","method","unique","concurrently"],["relation","indexName","table","columns","unique","concurrently","predicate"],["relation","indexName","table","columns","unique","concurrently"],["relation","injectionKind","matchedNeedle"],["relation","invokeName","path"],["relation","keyword",
    "keywordMapping","matchedNeedle","ownerHeading"],["relation","keyword","keywordMapping","matchedNeedle","rule"],["relation","keyword","matchedNeedle","call","requiredBy"],["relation","keyword","table","operator","cursor","requiredBy","column"],["relation","matchedNeedle"],["relation","method","methodSource","sourceFile"],["relation","objectName"],["relation","owner","channelName","event","schema","table","filter"],["relation","ownerHeading"],
    ["relation","ownerName","memberName"],["relation","ownerName","methodName"],["relation","ownerName","objectName"],["relation","ownerName","propertyName","isConst","isMutable","constructorParameter"],["relation","ownerName","propertyName","isConst","isMutable"],["relation","ownerName"],["relation","path","exportName"],["relation","path","invokeName"],["relation","path","redirectTo","pathMatch"],["relation","path","redirectTo"],["relation",
    "permission","declarationType"],["relation","pipeName","matchedNeedle"],["relation","pipeName","templateFile","matchedNeedle"],["relation","policy","command"],["relation","policy","expression"],["relation","policy","role"],["relation","policy","type"],["relation","provider","providerKind","bootstrapComponent","bootstrapLine","arguments","endLine"],["relation","provider","providerKind","bootstrapComponent","bootstrapLine","deps","endLine"],
    ["relation","provider","providerKind","bootstrapComponent","bootstrapLine","useClass","deps","endLine"],["relation","publication","action","table"],["relation","query","docPath"],["relation","queryType","queryValue"],["relation","queryType","queryValue","actions","categories","data"],["relation","question","docPath"],["relation","question","sourcePath"],["relation","resourceType","resourceName"],["relation","riskTag","riskSource"],["relation","scheme","host"],["relation","selector","element","matchedNeedle"],
    ["relation","selector","element","templateFile","matchedNeedle"],["relation","sourceFile"],["relation","status","action","owner"],["relation","table","action"],["relation","table","field","selectConfig"],["relation","table","operator","cursor","cursorKeyword","column"],["relation","table","writeOperation","optionKeys"],["relation","table","writeOperation","payloadKeys","optionKeys"],["relation","table","writeOperation","payloadKeys"],["relation",
    "table","writeOperation"],["relation","testMapping","matchedNeedle"],["relation","testMapping"],["relation","trigger","functionName"],["relation","trigger","table","timing","events"],["relation","typeName","memberName","targetName"],["relation","typeName","targetName","typeRole","parameterName"],["relation","typeName","targetName","typeRole"],["relation","typeName","targetName"],["relation","typeParameter"],["relation","view","materialized"],
    ["relation"],["synthesizedBy","via","registeredAt"]]],
  ["graph.edges[].metadata.actions[]",["line","name"],[["name","line"]]],
  ["graph.edges[].metadata.categories[]",["line","name"],[["name","line"]]],
  ["graph.edges[].metadata.data[]",["host","line","scheme"],[["scheme","host","line"]]],
["graph.nodes[]",["decorators","docstring","endColumn","endLine","filePath","id","isAbstract","isAsync","isExported","isStatic","kind","language","metadata","name","qualifiedName","returnType","signature","startColumn","startLine","typeParameters","updatedAt","visibility"],[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isAsync","isStatic",
    "isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isExported","isAbstract","updatedAt","metadata"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath",
    "language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature",
    "isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine",
    "startColumn","endColumn","docstring","signature","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","returnType","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","returnType","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature",
    "typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","isExported","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","returnType","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language",
    "startLine","endLine","startColumn","endColumn","docstring","signature","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","isStatic","isAbstract",
    "updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt","signature"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isExported","isAbstract","updatedAt","metadata"],["id","kind","name","qualifiedName","filePath","language",
    "startLine","endLine","startColumn","endColumn","signature","decorators","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isStatic","isAbstract","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isStatic","isAbstract",
    "updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine",
    "endLine","startColumn","endColumn","signature","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isStatic","isAbstract","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath",
    "language","startLine","endLine","startColumn","endColumn","signature","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath",
    "language","startLine","endLine","startColumn","endColumn","signature","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isAsync","isStatic","metadata","updatedAt","visibility"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType",
    "isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isExported","isAsync","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language",
    "startLine","endLine","startColumn","endColumn","signature","returnType","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature",
    "typeParameters","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","returnType","isExported","isAsync","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","returnType","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","decorators","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","decorators","returnType","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine",
    "startColumn","endColumn","signature","visibility","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isStatic","isAbstract","updatedAt"],["id",
    "kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn",
    "endColumn","signature","visibility","returnType","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","typeParameters","returnType",
    "isAsync","isStatic","isAbstract","updatedAt"]]],
["graph.nodes[].metadata",["action","alias","angularProperty","annotationNames","argNames","body","bootstrapComponent","bucket","categories","category","changeDetection","channelName","channelVariable","classKind","className","column","columns","command","componentType","concurrently","configObject","configPath","configProperty","constraintSource","constraintType","constructorParameter","cursor","cursorKeyword","declarationKind","deferrable","decorator","doc",
    "docs","envVar","event","events","excludeElements","exportName","expression","field","filter","framework","functionName","grantOption","grantOptionFor","header","importedName","indexMethod","initially","invokeName","isConst","isMutable","isOverride","isTypeOnly","keywordMapping","keywords","language","legacyRelation","matchedNeedle","matchType","materialized","memberName","method","methodSource","modifiers","name","normalizedHeader","notValid","nullsDistinct","objectName","objectNames","objectType","onDelete","onDeleteColumns","onUpdate","onUpdateColumns",
    "operator","optionKeys","orReplace","overloadSignatures","overloads","owner","ownerHeading","ownerName","ownerQualifiedName","packageName","parameterName","parentConfigPath","path","pathMatch","payloadKeys","permission","pipeName","platform","policy","predicate","primary","privilege","privileges","providedIn","publication","pure","query","queryType","queryValue","question","redirectTo","referencedColumns","referencedTable","relation",
    "resourceName","resourceType","returnType","revokeBehavior","riskSource","riskTag","riskTags","role","roles","rootTag","routeQueries","rule","schema","secondary","security","selectConfig","selectSource","selector","source","sourcePath","sourcePaths","standalone","status","storageSource","table","target","targetName","timing","title","type","typeName","typeRole","unique","using","usingIndex","valueType","view","wildcard","withCheck","writeOperation"],[["framework",
    "decorator","pipeName","standalone","pure"],["framework","decorator","providedIn"],["framework","decorator","selector","standalone","changeDetection"],["framework","decorator","selector","standalone"],["framework","decorator","selector"],["framework","decorator"],["framework","path","exportName"],["framework","path","pathMatch","exportName"],["framework","path","redirectTo","pathMatch"],["framework","path","redirectTo"],["framework","path"],["relation","framework","path","exportName"],["framework","relation","angularProperty",
    "legacyRelation"],["framework"],["importedName","target","relation","isTypeOnly"],["name","exportName","target","relation","isTypeOnly"],["overloads","overloadSignatures"],["platform","relation","className","componentType"],["platform","relation","header","normalizedHeader","functionName"],["platform","relation","importedName","target","packageName","wildcard"],["platform","relation","importedName","alias","target","packageName","wildcard"],["platform","relation","invokeName"],["platform","relation","method","methodSource",
    "functionName"],["platform","relation","packageName","classKind","declarationKind","modifiers","annotationNames"],["platform","relation","packageName","classKind","declarationKind","modifiers","ownerName","ownerQualifiedName"],["platform","relation","packageName","classKind","declarationKind","modifiers"],["platform","relation","packageName","classKind"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable",
    "isOverride","constructorParameter","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","constructorParameter","typeName","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","constructorParameter","typeName"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable",
    "isOverride","constructorParameter"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","typeName"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride"],["platform","relation","packageName","ownerName","ownerQualifiedName","isOverride","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isOverride"],
    ["platform","relation","packageName","ownerName","ownerQualifiedName"],["platform","relation","packageName"],["platform","relation","permission"],["platform","relation","queryType","queryValue"],["platform","relation","resourceType","resourceName","rootTag"],["platform","relation","resourceType","resourceName"],["platform","relation","valueType"],["platform","relation"],["platform","riskTags"],["relation","action","objectType","objectName",
    "privileges","roles","grantOption"],["relation","action","objectType","objectName","privileges","roles","grantOptionFor"],["relation","action","owner","channelVariable"],["relation","action","privilege","objectType","objectNames","roles","grantOption"],["relation","action","privilege","objectType","objectNames","roles","grantOptionFor"],["relation","action","role","privileges","objectType","objectNames","grantOption"],["relation","action","role",
    "privileges","objectType","objectNames","grantOptionFor"],["relation","bucket","storageSource","policy","table"],["relation","bucket","storageSource"],["relation","channelName","owner"],["relation","configObject","configPath","configProperty"],["relation","configObject","configPath","parentConfigPath","configProperty"],["relation","envVar"],["relation","framework","bootstrapComponent"],["relation","framework","source","sourcePath"],["relation",
    "framework"],["relation","functionName","argNames"],["relation","functionName"],["relation","owner","channelName","event","schema","table","filter"],["relation","ownerHeading","rule"],["relation","publication","action","table"],["relation","returnType","language","security"],["relation","returnType","language"],["relation","returnType","security"],["relation","returnType"],["relation","riskTag","riskSource"],["relation","rule","keywordMapping",
    "matchedNeedle"],["relation","source","sourcePath"],["relation","status","action","owner"],["relation","table","action"],["relation","table","column","operator","cursor","cursorKeyword"],["relation","table","columns","method","unique","concurrently"],["relation","table","columns","unique","concurrently","predicate"],["relation","table","columns","unique","concurrently"],["relation","table","command","type","roles","using","withCheck"],["relation",
    "table","command","type","roles","using"],["relation","table","command","type","roles","withCheck"],["relation","table","constraintType","constraintSource","columns","notValid"],["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","notValid"],["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","onDelete","notValid"],["relation","table",
    "constraintType","constraintSource","expression","notValid"],["relation","table","constraintType","constraintSource","usingIndex","notValid"],["relation","table","field","selectConfig"],["relation","table","field","selectSource"],["relation","table","timing","events","functionName"],["relation","table","writeOperation","optionKeys"],["relation","table","writeOperation","payloadKeys","optionKeys"],["relation","table","writeOperation",
    "payloadKeys"],["relation","table","writeOperation"],["relation","typeName","memberName","targetName"],["relation","typeName","targetName","typeRole","parameterName"],["relation","typeName","targetName","typeRole"],["relation","typeName","targetName"],["relation","view","materialized","orReplace"],["relation"],["source","relation","body","keywords"],["source","relation","category","docs"],["source","relation","ownerHeading","body","keywords"],
    ["source","relation","query","primary","secondary"],["source","relation","question","doc","docs","sourcePaths"],["source","relation","sourcePath"],["source","relation","title","categories","routeQueries"],["target","relation","isTypeOnly"]]],
];
const ARRAY_PATHS = [
  "graph.edges", "graph.edges[].metadata.actions", "graph.edges[].metadata.argNames",
  "graph.edges[].metadata.categories", "graph.edges[].metadata.data",
  "graph.edges[].metadata.arguments", "graph.edges[].metadata.columns", "graph.edges[].metadata.deps", "graph.edges[].metadata.excludeElements",
  "graph.edges[].metadata.events", "graph.edges[].metadata.inputs", "graph.edges[].metadata.objectNames", "graph.edges[].metadata.onDeleteColumns",
  "graph.edges[].metadata.onUpdateColumns", "graph.edges[].metadata.optionKeys", "graph.edges[].metadata.outputs", "graph.edges[].metadata.payloadKeys", "graph.edges[].metadata.privileges", "graph.edges[].metadata.referencedColumns",
  "graph.edges[].metadata.roles", "graph.nodes", "graph.nodes[].decorators",
  "graph.nodes[].metadata.annotationNames", "graph.nodes[].metadata.argNames", "graph.nodes[].metadata.categories",
  "graph.nodes[].metadata.columns", "graph.nodes[].metadata.docs", "graph.nodes[].metadata.events", "graph.nodes[].metadata.excludeElements",
  "graph.nodes[].metadata.keywords", "graph.nodes[].metadata.modifiers", "graph.nodes[].metadata.objectNames", "graph.nodes[].metadata.onDeleteColumns", "graph.nodes[].metadata.onUpdateColumns",
  "graph.nodes[].metadata.optionKeys", "graph.nodes[].metadata.overloadSignatures", "graph.nodes[].metadata.payloadKeys",
  "graph.nodes[].metadata.privileges", "graph.nodes[].metadata.referencedColumns", "graph.nodes[].metadata.riskTags",
  "graph.nodes[].metadata.roles", "graph.nodes[].metadata.routeQueries", "graph.nodes[].metadata.secondary",
  "graph.nodes[].metadata.sourcePaths", "graph.nodes[].typeParameters",
];
const SCALAR_TYPE_GROUPS = [
  [["boolean"], [
    "graph.edges[].metadata.concurrently", "graph.edges[].metadata.constructorParameter", "graph.edges[].metadata.grantOption",
    "graph.edges[].metadata.deferrable", "graph.edges[].metadata.grantOptionFor", "graph.edges[].metadata.isConst", "graph.edges[].metadata.isMutable",
    "graph.edges[].metadata.isTypeOnly", "graph.edges[].metadata.materialized", "graph.edges[].metadata.notValid", "graph.edges[].metadata.nullsDistinct",
    "graph.edges[].metadata.unique", "graph.edges[].metadata.wildcard", "graph.nodes[].isAbstract",
    "graph.nodes[].isAsync", "graph.nodes[].isExported", "graph.nodes[].isStatic",
    "graph.nodes[].metadata.concurrently", "graph.nodes[].metadata.constructorParameter", "graph.nodes[].metadata.deferrable", "graph.nodes[].metadata.grantOption",
    "graph.nodes[].metadata.grantOptionFor", "graph.nodes[].metadata.isConst", "graph.nodes[].metadata.isMutable",
    "graph.nodes[].metadata.isOverride", "graph.nodes[].metadata.isTypeOnly", "graph.nodes[].metadata.materialized",
    "graph.nodes[].metadata.notValid", "graph.nodes[].metadata.nullsDistinct", "graph.nodes[].metadata.orReplace", "graph.nodes[].metadata.pure",
    "graph.nodes[].metadata.standalone", "graph.nodes[].metadata.unique", "graph.nodes[].metadata.wildcard",
  ]],
  [["number"], [
    "graph.edges[].column", "graph.edges[].line", "graph.edges[].metadata.actions[].line",
    "graph.edges[].metadata.bootstrapLine", "graph.edges[].metadata.categories[].line", "graph.edges[].metadata.data[].line",
    "graph.edges[].metadata.endLine", "graph.nodes[].endColumn", "graph.nodes[].endLine",
    "graph.nodes[].metadata.overloads", "graph.nodes[].startColumn", "graph.nodes[].startLine",
    "graph.nodes[].updatedAt", "graph.schemaVersion",
  ]],
  [["string"], [
    "graph.edges[].kind", "graph.edges[].metadata.action", "graph.edges[].metadata.actions[]", "graph.edges[].metadata.actions[].name",
    "graph.edges[].metadata.categories[].name", "graph.edges[].metadata.data[].host", "graph.edges[].metadata.data[].scheme",
    "graph.edges[].metadata.alias", "graph.edges[].metadata.angularProperty", "graph.edges[].metadata.annotationName", "graph.edges[].metadata.annotationQualifiedName",
    "graph.edges[].metadata.api", "graph.edges[].metadata.argNames[]", "graph.edges[].metadata.arguments[]",
    "graph.edges[].metadata.attribute", "graph.edges[].metadata.attributeValue", "graph.edges[].metadata.binding", "graph.edges[].metadata.bindingKind",
    "graph.edges[].metadata.bootstrapComponent", "graph.edges[].metadata.bucket", "graph.edges[].metadata.call",
    "graph.edges[].metadata.callName", "graph.edges[].metadata.category", "graph.edges[].metadata.channelName",
    "graph.edges[].metadata.channelVariable", "graph.edges[].metadata.className", "graph.edges[].metadata.column",
    "graph.edges[].metadata.columns[]", "graph.edges[].metadata.command", "graph.edges[].metadata.componentType",
    "graph.edges[].metadata.configKey", "graph.edges[].metadata.configObject", "graph.edges[].metadata.configPath",
    "graph.edges[].metadata.configProperty", "graph.edges[].metadata.constraintName", "graph.edges[].metadata.constraintSource",
    "graph.edges[].metadata.constraintType", "graph.edges[].metadata.cursor", "graph.edges[].metadata.cursorKeyword",
    "graph.edges[].metadata.declarationType", "graph.edges[].metadata.deps[]", "graph.edges[].metadata.docPath", "graph.edges[].metadata.excludeElements[]",
    "graph.edges[].metadata.element", "graph.edges[].metadata.envVar", "graph.edges[].metadata.event",
    "graph.edges[].metadata.events[]", "graph.edges[].metadata.exportName", "graph.edges[].metadata.exported",
    "graph.edges[].metadata.expression", "graph.edges[].metadata.field", "graph.edges[].metadata.filter",
    "graph.edges[].metadata.framework", "graph.edges[].metadata.functionName", "graph.edges[].metadata.guardKind",
    "graph.edges[].metadata.header", "graph.edges[].metadata.host", "graph.edges[].metadata.importedName",
    "graph.edges[].metadata.indexMethod", "graph.edges[].metadata.indexName", "graph.edges[].metadata.initially", "graph.edges[].metadata.injectionKind", "graph.edges[].metadata.inputs[]", "graph.edges[].metadata.invokeName",
    "graph.edges[].metadata.keyword", "graph.edges[].metadata.keywordMapping", "graph.edges[].metadata.kind",
    "graph.edges[].metadata.language", "graph.edges[].metadata.legacyRelation", "graph.edges[].metadata.manifestFile", "graph.edges[].metadata.matchType",
    "graph.edges[].metadata.matchedNeedle", "graph.edges[].metadata.memberName", "graph.edges[].metadata.method",
    "graph.edges[].metadata.methodName", "graph.edges[].metadata.methodSource", "graph.edges[].metadata.normalizedHeader",
    "graph.edges[].metadata.objectName", "graph.edges[].metadata.objectNames[]", "graph.edges[].metadata.objectType",
    "graph.edges[].metadata.onDelete", "graph.edges[].metadata.onDeleteColumns[]", "graph.edges[].metadata.onUpdate", "graph.edges[].metadata.onUpdateColumns[]", "graph.edges[].metadata.operator", "graph.edges[].metadata.optionKeys[]", "graph.edges[].metadata.outputs[]",
    "graph.edges[].metadata.owner", "graph.edges[].metadata.ownerHeading", "graph.edges[].metadata.ownerName",
    "graph.edges[].metadata.packageName", "graph.edges[].metadata.parameterName", "graph.edges[].metadata.parentConfigPath",
    "graph.edges[].metadata.path", "graph.edges[].metadata.pathMatch", "graph.edges[].metadata.payloadKeys[]",
    "graph.edges[].metadata.permission", "graph.edges[].metadata.pipeName", "graph.edges[].metadata.policy",
    "graph.edges[].metadata.predicate", "graph.edges[].metadata.privilege", "graph.edges[].metadata.privileges[]",
    "graph.edges[].metadata.propertyName", "graph.edges[].metadata.provider", "graph.edges[].metadata.providerKind",
    "graph.edges[].metadata.publication", "graph.edges[].metadata.query", "graph.edges[].metadata.queryType",
    "graph.edges[].metadata.queryValue", "graph.edges[].metadata.question", "graph.edges[].metadata.rawName",
    "graph.edges[].metadata.receiver", "graph.edges[].metadata.redirectTo", "graph.edges[].metadata.referencedColumns[]",
    "graph.edges[].metadata.referencedTable", "graph.edges[].metadata.registeredAt", "graph.edges[].metadata.relation", "graph.edges[].metadata.resolverKey",
    "graph.edges[].metadata.requiredBy", "graph.edges[].metadata.resourceName", "graph.edges[].metadata.resourceType",
    "graph.edges[].metadata.returnType", "graph.edges[].metadata.revokeBehavior", "graph.edges[].metadata.riskSource", "graph.edges[].metadata.riskTag",
    "graph.edges[].metadata.role", "graph.edges[].metadata.roles[]", "graph.edges[].metadata.rule",
    "graph.edges[].metadata.schema", "graph.edges[].metadata.scheme", "graph.edges[].metadata.security",
    "graph.edges[].metadata.selectConfig", "graph.edges[].metadata.selectSource", "graph.edges[].metadata.selector",
    "graph.edges[].metadata.sourceFile", "graph.edges[].metadata.sourcePath", "graph.edges[].metadata.status",
    "graph.edges[].metadata.storageSource", "graph.edges[].metadata.synthesizedBy", "graph.edges[].metadata.table",
    "graph.edges[].metadata.target", "graph.edges[].metadata.targetName", "graph.edges[].metadata.templateFile",
    "graph.edges[].metadata.testMapping", "graph.edges[].metadata.timing", "graph.edges[].metadata.trigger",
    "graph.edges[].metadata.type", "graph.edges[].metadata.typeName", "graph.edges[].metadata.typeParameter",
    "graph.edges[].metadata.typeRole", "graph.edges[].metadata.useClass", "graph.edges[].metadata.usingIndex",
    "graph.edges[].metadata.value", "graph.edges[].metadata.via", "graph.edges[].metadata.view",
    "graph.edges[].metadata.writeOperation", "graph.edges[].provenance", "graph.edges[].source",
    "graph.edges[].target", "graph.nodes[].decorators[]", "graph.nodes[].docstring",
    "graph.nodes[].filePath", "graph.nodes[].id", "graph.nodes[].kind",
    "graph.nodes[].language", "graph.nodes[].metadata.action", "graph.nodes[].metadata.alias", "graph.nodes[].metadata.angularProperty",
    "graph.nodes[].metadata.annotationNames[]", "graph.nodes[].metadata.argNames[]", "graph.nodes[].metadata.body",
    "graph.nodes[].metadata.bootstrapComponent", "graph.nodes[].metadata.bucket", "graph.nodes[].metadata.categories[]",
    "graph.nodes[].metadata.category", "graph.nodes[].metadata.changeDetection", "graph.nodes[].metadata.channelName",
    "graph.nodes[].metadata.channelVariable", "graph.nodes[].metadata.classKind", "graph.nodes[].metadata.className",
    "graph.nodes[].metadata.column", "graph.nodes[].metadata.columns[]", "graph.nodes[].metadata.command",
    "graph.nodes[].metadata.componentType", "graph.nodes[].metadata.configObject", "graph.nodes[].metadata.configPath",
    "graph.nodes[].metadata.configProperty", "graph.nodes[].metadata.constraintSource", "graph.nodes[].metadata.constraintType",
    "graph.nodes[].metadata.cursor", "graph.nodes[].metadata.cursorKeyword", "graph.nodes[].metadata.declarationKind",
    "graph.nodes[].metadata.decorator", "graph.nodes[].metadata.doc", "graph.nodes[].metadata.docs[]",
    "graph.nodes[].metadata.envVar", "graph.nodes[].metadata.event", "graph.nodes[].metadata.events[]", "graph.nodes[].metadata.excludeElements[]",
    "graph.nodes[].metadata.exportName", "graph.nodes[].metadata.expression", "graph.nodes[].metadata.field",
    "graph.nodes[].metadata.filter", "graph.nodes[].metadata.framework", "graph.nodes[].metadata.functionName",
    "graph.nodes[].metadata.header", "graph.nodes[].metadata.importedName", "graph.nodes[].metadata.indexMethod", "graph.nodes[].metadata.initially", "graph.nodes[].metadata.invokeName",
    "graph.nodes[].metadata.keywordMapping", "graph.nodes[].metadata.keywords[]", "graph.nodes[].metadata.language",
    "graph.nodes[].metadata.legacyRelation", "graph.nodes[].metadata.matchedNeedle", "graph.nodes[].metadata.matchType", "graph.nodes[].metadata.memberName",
    "graph.nodes[].metadata.method", "graph.nodes[].metadata.methodSource", "graph.nodes[].metadata.modifiers[]",
    "graph.nodes[].metadata.name", "graph.nodes[].metadata.normalizedHeader", "graph.nodes[].metadata.objectName",
    "graph.nodes[].metadata.objectNames[]", "graph.nodes[].metadata.objectType", "graph.nodes[].metadata.onDelete", "graph.nodes[].metadata.onDeleteColumns[]", "graph.nodes[].metadata.onUpdate", "graph.nodes[].metadata.onUpdateColumns[]",
    "graph.nodes[].metadata.operator", "graph.nodes[].metadata.optionKeys[]", "graph.nodes[].metadata.overloadSignatures[]",
    "graph.nodes[].metadata.owner", "graph.nodes[].metadata.ownerHeading", "graph.nodes[].metadata.ownerName",
    "graph.nodes[].metadata.ownerQualifiedName", "graph.nodes[].metadata.packageName", "graph.nodes[].metadata.parameterName",
    "graph.nodes[].metadata.parentConfigPath", "graph.nodes[].metadata.path", "graph.nodes[].metadata.pathMatch",
    "graph.nodes[].metadata.payloadKeys[]", "graph.nodes[].metadata.permission", "graph.nodes[].metadata.pipeName",
    "graph.nodes[].metadata.platform", "graph.nodes[].metadata.policy", "graph.nodes[].metadata.predicate",
    "graph.nodes[].metadata.primary", "graph.nodes[].metadata.privilege", "graph.nodes[].metadata.privileges[]",
    "graph.nodes[].metadata.providedIn", "graph.nodes[].metadata.publication", "graph.nodes[].metadata.query",
    "graph.nodes[].metadata.queryType", "graph.nodes[].metadata.queryValue", "graph.nodes[].metadata.question",
    "graph.nodes[].metadata.redirectTo", "graph.nodes[].metadata.referencedColumns[]", "graph.nodes[].metadata.referencedTable",
    "graph.nodes[].metadata.relation", "graph.nodes[].metadata.resourceName", "graph.nodes[].metadata.resourceType",
    "graph.nodes[].metadata.returnType", "graph.nodes[].metadata.revokeBehavior", "graph.nodes[].metadata.riskSource", "graph.nodes[].metadata.riskTag",
    "graph.nodes[].metadata.riskTags[]", "graph.nodes[].metadata.role", "graph.nodes[].metadata.roles[]",
    "graph.nodes[].metadata.rootTag", "graph.nodes[].metadata.routeQueries[]", "graph.nodes[].metadata.rule",
    "graph.nodes[].metadata.schema", "graph.nodes[].metadata.secondary[]", "graph.nodes[].metadata.security",
    "graph.nodes[].metadata.selectConfig", "graph.nodes[].metadata.selectSource", "graph.nodes[].metadata.selector",
    "graph.nodes[].metadata.source", "graph.nodes[].metadata.sourcePath", "graph.nodes[].metadata.sourcePaths[]",
    "graph.nodes[].metadata.status", "graph.nodes[].metadata.storageSource", "graph.nodes[].metadata.table",
    "graph.nodes[].metadata.target", "graph.nodes[].metadata.targetName", "graph.nodes[].metadata.timing",
    "graph.nodes[].metadata.title", "graph.nodes[].metadata.type", "graph.nodes[].metadata.typeName",
    "graph.nodes[].metadata.typeRole", "graph.nodes[].metadata.using", "graph.nodes[].metadata.usingIndex",
    "graph.nodes[].metadata.valueType", "graph.nodes[].metadata.view", "graph.nodes[].metadata.withCheck",
    "graph.nodes[].metadata.writeOperation", "graph.nodes[].name", "graph.nodes[].qualifiedName",
    "graph.nodes[].returnType", "graph.nodes[].signature", "graph.nodes[].typeParameters[]",
    "graph.nodes[].visibility",
  ]],
];
const NODE_KINDS = [
  "class","component","constant","enum","enum_member","export","file","function","import","interface","method","namespace","parameter","property","route","type_alias","variable",
];
const EDGE_KINDS = [
  "calls","contains","decorates","exports","extends","implements","imports","instantiates","overrides","references","returns","type_of",
];
const LANGUAGES = [
  "javascript","jsx","kotlin","tsx","typescript","unknown","xml",
];
const VISIBILITIES = [
  "internal","private","protected","public",
];
const NODE_ORDERS_BY_KIND = [
["class",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isExported","isAbstract","updatedAt","metadata"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language",
    "startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isExported","isAbstract","updatedAt","metadata"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isExported","isAbstract",
    "updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isStatic","isAbstract","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn",
    "endColumn","signature","isStatic","isAbstract","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isExported","isAbstract","updatedAt"]]],
  ["component",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"]]],
  ["constant",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","updatedAt"]]],
  ["enum",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"]]],
  ["enum_member",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","updatedAt"]]],
  ["export",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"]]],
  ["file",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt","signature"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"]]],
["function",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","returnType","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine",
    "startColumn","endColumn","docstring","signature","typeParameters","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","returnType","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync",
    "updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isExported","isAsync","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine",
    "startColumn","endColumn","signature","returnType","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isExported","isAsync","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","returnType","isExported","isAsync","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","returnType","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isAsync","isStatic","metadata","updatedAt"]]],
  ["import",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"]]],
["interface",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isStatic","isAbstract","metadata","updatedAt"]]],
["method",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine",
    "endLine","startColumn","endColumn","docstring","signature","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","returnType","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","isAsync","isStatic",
    "isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine",
    "endLine","startColumn","endColumn","docstring","signature","visibility","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring",
    "signature","visibility","typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isAsync",
    "isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine",
    "startColumn","endColumn","signature","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isAsync","isStatic","metadata","updatedAt","visibility"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","isAsync","isStatic","metadata",
    "updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","returnType","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","returnType","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","updatedAt"],["id","kind","name","qualifiedName","filePath",
    "language","startLine","endLine","startColumn","endColumn","signature","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","decorators","returnType","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isAsync","isStatic","isAbstract",
    "updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","returnType","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine",
    "endLine","startColumn","endColumn","signature","visibility","returnType","isAsync","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","typeParameters","isAsync","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility",
    "typeParameters","returnType","isAsync","isStatic","isAbstract","updatedAt"],
  ["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","decorators","returnType","isAsync","isStatic","metadata","updatedAt"],
  ["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","visibility","decorators","isAsync","isStatic","metadata","updatedAt"],
  ["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","visibility","decorators","isAsync","isStatic","isAbstract","updatedAt"]]],
  ["namespace",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","updatedAt"]]],
  ["parameter",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","updatedAt"]]],
["property",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","decorators","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine",
    "startColumn","endColumn","docstring","signature","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","visibility","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath",
    "language","startLine","endLine","startColumn","endColumn","signature","decorators","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","decorators","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isStatic","isAbstract","updatedAt"],["id",
    "kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isStatic","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","updatedAt"],["id","kind","name",
    "qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","decorators","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","visibility","isStatic","isAbstract","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature",
    "visibility","isStatic","metadata","updatedAt"],
  ["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn",
    "signature","visibility","decorators","isStatic","metadata","updatedAt"]]],
  ["route",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"]]],
["type_alias",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","typeParameters","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn",
    "endColumn","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","typeParameters","isExported","updatedAt"]]],
["variable",[["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","metadata","updatedAt"],["id","kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","isExported","updatedAt"],["id",
    "kind","name","qualifiedName","filePath","language","startLine","endLine","startColumn","endColumn","signature","metadata","updatedAt"]]],
];
const EDGE_ORDERS_BY_KIND = [
  ["calls",[["kind","source","target","line","metadata"],["kind","source","target","line","provenance","metadata"],["kind","source","target","metadata"]]],
  ["contains",[["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["decorates",[["kind","source","target","line","column","metadata"],["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["exports",[["kind","source","target","line","metadata"]]],
  ["extends",[["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["implements",[["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["imports",[["kind","source","target","line","column","metadata"],["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["instantiates",[["kind","source","target","metadata"]]],
  ["overrides",[["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["references",[["kind","source","target","line","column","metadata"],["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
  ["returns",[["kind","source","target","metadata"]]],
  ["type_of",[["kind","source","target","line","column","metadata"],["kind","source","target","line","metadata"],["kind","source","target","metadata"]]],
];
const NODE_METADATA_ORDERS = [
  ["@none:class",[["framework","decorator","pipeName","standalone","pure"],["framework","decorator","pipeName","standalone"],["framework","decorator","pipeName","pure"],["framework","decorator","pipeName"],["framework","decorator","providedIn"],["framework","decorator","selector","standalone"],["framework","decorator","selector"],["framework","decorator"]]],
  ["@none:component",[["framework","decorator","selector","standalone","changeDetection"],["framework","decorator","selector","standalone"],["framework","decorator","selector"]]],
  ["@none:file",[["platform","riskTags"]]],
  ["@none:function",[["overloads","overloadSignatures"],["platform","riskTags"]]],
  ["@none:route",[["framework","path","exportName"],["framework","path","pathMatch","exportName"],["framework","path","redirectTo","pathMatch"],["framework","path","redirectTo"],["framework","path"],["framework"]]],
  ["android-kotlin-annotation",[["relation"]]],
  ["android-kotlin-class",[["platform","relation","packageName","classKind","declarationKind","modifiers","annotationNames"],["platform","relation","packageName","classKind","declarationKind","modifiers"]]],["android-kotlin-interface",[["platform","relation","packageName","classKind","declarationKind","modifiers"]]],
  ["android-kotlin-companion-object",[["platform","relation","packageName","classKind","declarationKind","modifiers","ownerName","ownerQualifiedName"]]],
  ["android-kotlin-constructor",[["platform","relation","packageName","ownerName","ownerQualifiedName"]]],
  ["android-kotlin-enum",[["platform","relation","packageName","classKind"]]],
  ["android-kotlin-enum-member",[["platform","relation","packageName","ownerName","ownerQualifiedName"]]],
  ["android-kotlin-extends",[["relation","typeName","targetName"]]],
  ["android-kotlin-function",[["platform","relation","packageName"]]],
  ["android-kotlin-implements",[["relation","typeName","targetName"]]],
  ["android-kotlin-import",[["platform","relation","importedName","target","packageName","wildcard"],["platform","relation","importedName","alias","target","packageName","wildcard"],["relation"]]],
  ["android-kotlin-method",[["platform","relation","packageName","ownerName","ownerQualifiedName","isOverride","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isOverride"]]],
  ["android-kotlin-object",[["platform","relation","packageName","classKind","declarationKind","modifiers"]]],
  ["android-kotlin-override",[["relation","typeName","memberName","targetName"]]],
["android-kotlin-property",[["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","constructorParameter","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","constructorParameter","typeName","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride",
    "constructorParameter","typeName"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","constructorParameter"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","typeName","annotationNames"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride","typeName"],["platform","relation","packageName","ownerName","ownerQualifiedName","isConst","isMutable","isOverride"]]],
  ["android-kotlin-source",[["platform","relation"]]],
  ["android-kotlin-type-reference",[["relation","typeName","targetName","typeRole","parameterName"],["relation","typeName","targetName","typeRole"]]],
  ["android-manifest",[["platform","relation"]]],
  ["android-manifest-component",[["platform","relation","className","componentType"]]],
  ["android-manifest-intent-filter-value",[["platform","relation","valueType"]]],
  ["android-manifest-permission",[["platform","relation","permission"]]],
  ["android-manifest-query",[["platform","relation","queryType","queryValue"]]],
  ["android-resource-file",[["platform","relation","resourceType","resourceName","rootTag"],["platform","relation","resourceType","resourceName"]]],
  ["angular-app-config",[["relation","framework","bootstrapComponent"]]],
  ["angular-app-provider",[["relation"]]],
  ["commonjs-export",[["name","exportName","target","relation","isTypeOnly"]]],
  ["commonjs-require",[["importedName","target","relation","isTypeOnly"]]],
  ["config-property",[["relation","configObject","configPath","configProperty"],["relation","configObject","configPath","parentConfigPath","configProperty"]]],
  ["context7-category",[["source","relation","category","docs"]]],
  ["context7-doc",[["source","relation","title","categories","routeQueries"]]],
  ["context7-retrieval-route",[["source","relation","query","primary","secondary"]]],
  ["context7-source-map-route",[["source","relation","question","doc","docs","sourcePaths"]]],
  ["context7-source-path",[["relation","framework","source","sourcePath"],["relation","source","sourcePath"],["source","relation","sourcePath"]]],
  ["decorator",[["relation"]]],
  ["decorator-argument",[["relation"]]],
  ["dependency",[["relation"]]],
  ["dynamic-import-file",[["relation","framework"]]],
  ["dynamic-import-target",[["relation","framework"]]],
  ["edge-function-header",[["platform","relation","header","normalizedHeader","functionName"]]],
  ["edge-function-method",[["platform","relation","method","methodSource","functionName"]]],
  ["edge-function-route",[["platform","relation","invokeName"]]],
  ["edge-function-source",[["relation"]]],
  ["env-var",[["relation","envVar"]]],
  ["export",[["name","exportName","target","relation","isTypeOnly"],["relation"]]],
  ["export-equals",[["name","exportName","target","relation","isTypeOnly"],["relation"]]],
  ["export-file",[["relation"]]],
  ["extends",[["relation"]]],
  ["external-reference",[["relation"]]],
  ["hard-rule",[["source","relation","body","keywords"]]],
  ["hard-rule-keyword",[["relation","rule","keywordMapping","matchedNeedle"]]],
  ["host-attribute",[["relation"]]],
  ["implements",[["relation"]]],
  ["import",[["importedName","target","relation","isTypeOnly"],["relation"],["target","relation","isTypeOnly"]]],
  ["initializer-reference",[["relation"]]],
  ["injector-file",[["relation","framework"]]],
  ["migration-constraint",[
    ["relation","table","constraintType","constraintSource","columns","notValid"],
    ["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","notValid"],
    ["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","onDelete","notValid"],
    ["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","onDelete","onDeleteColumns","onUpdate","onUpdateColumns","notValid"],
    ["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","onUpdate","notValid"],
    ["relation","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","matchType","onDelete","onUpdate","deferrable","initially","notValid"],
    ["relation","table","constraintType","constraintSource","columns","nullsDistinct","notValid"],
    ["relation","table","constraintType","constraintSource","columns","nullsDistinct","deferrable","initially","notValid"],
    ["relation","table","constraintType","constraintSource","expression","notValid"],
    ["relation","table","constraintType","constraintSource","indexMethod","excludeElements","predicate","notValid"],
    ["relation","table","constraintType","constraintSource","usingIndex","notValid"],
    ["relation","table","constraintType","constraintSource","usingIndex","deferrable","notValid"],
  ]],
  ["migration-index",[["relation","table","columns","method","unique","concurrently"],["relation","table","columns","unique","concurrently","predicate"],["relation","table","columns","unique","concurrently"]]],
  ["migration-realtime-publication",[["relation","publication","action","table"]]],
  ["migration-rls",[["relation","table","action"]]],
  ["migration-view",[["relation","view","materialized","orReplace"]]],
  ["new",[["relation"]]],
  ["namespace-member",[["relation"]]],
  ["parameter-type",[["relation"]]],
  ["pipe-name",[["relation"]]],
  ["policy",[["relation","table","command","type","roles","using","withCheck"],["relation","table","command","type","roles","using"],["relation","table","command","type","roles","withCheck"],["relation"]]],
  ["privilege",[["relation","action","privilege","objectType","objectNames","roles","grantOption"],["relation","action","privilege","objectType","objectNames","roles","grantOptionFor"],["relation","action","privilege","objectType","objectNames","roles","grantOptionFor","revokeBehavior"]]],
  ["privilege-object",[["relation","action","objectType","objectName","privileges","roles","grantOption"],["relation","action","objectType","objectName","privileges","roles","grantOptionFor"],["relation","action","objectType","objectName","privileges","roles","grantOptionFor","revokeBehavior"]]],
  ["privilege-role",[["relation","action","role","privileges","objectType","objectNames","grantOption"],["relation","action","role","privileges","objectType","objectNames","grantOptionFor"],["relation","action","role","privileges","objectType","objectNames","grantOptionFor","revokeBehavior"]]],
  ["providedIn",[["relation"]]],
  ["query",[["relation"]]],
  ["re-export",[["name","exportName","target","relation","isTypeOnly"]]],
  ["re-export-file",[["relation"]]],
  ["return-type",[["relation"]]],
  ["risk-tag",[["relation","riskTag","riskSource"]]],
  ["route-target",[["relation","framework","path","exportName"]]],
  ["source-file",[["platform","relation"],["relation"]]],
  ["sql-function",[["relation","returnType","language","security"],["relation","returnType","language"],["relation","returnType","security"],["relation","returnType"]]],
  ["style-url",[["framework","relation","angularProperty","legacyRelation"]]],
  ["supabase-incremental-predicate",[["relation","table","column","operator","cursor","cursorKeyword"]]],
  ["supabase-realtime-channel",[["relation","channelName","owner"]]],
  ["supabase-realtime-postgres-change",[["relation","owner","channelName","event","schema","table","filter"]]],
  ["supabase-realtime-remove-all-channels",[["relation","action","owner"]]],
  ["supabase-realtime-remove-channel",[["relation","action","owner","channelName"],["relation","action","owner","channelName","channelVariable"],["relation","action","owner","channelVariable"]]],
  ["supabase-realtime-status",[["relation","status","action","owner"]]],
  ["supabase-realtime-unsubscribe",[["relation","action","owner","channelName"],["relation","action","owner","channelName","channelVariable"],["relation","action","owner","channelVariable"]]],
  ["supabase-rpc",[["relation","functionName","argNames"],["relation","functionName"]]],
  ["supabase-select-field",[["relation","table","field","selectConfig"],["relation","table","field","selectSource"]]],
  ["supabase-storage-bucket",[["relation","bucket","storageSource","policy","table"],["relation","bucket","storageSource"]]],
  ["supabase-table-write",[["relation","table","writeOperation","optionKeys"],["relation","table","writeOperation","payloadKeys","optionKeys"],["relation","table","writeOperation","payloadKeys"],["relation","table","writeOperation"]]],
  ["sync-rule",[["source","relation","ownerHeading","body","keywords"]]],
  ["sync-rule-keyword",[["relation","ownerHeading","rule"]]],
  ["table",[["relation"]]],
  ["template-binding",[["relation"]]],
  ["template-url",[["framework","relation","angularProperty","legacyRelation"]]],
  ["test",[["relation"]]],
  ["trigger",[["relation","table","timing","events","functionName"]]],
  ["trigger-function",[["relation"]]],
  ["type-reference",[["relation"]]],
];
const EDGE_METADATA_ORDERS = [
  ["@none:calls",[["synthesizedBy","via","registeredAt"]]],
  ["android-kotlin-annotation",[["relation","annotationName","annotationQualifiedName"]]],
  ["android-kotlin-call",[["relation","callName","receiver"],["relation","callName"]]],
  ["android-kotlin-companion-object",[["relation","ownerName","objectName"]]],
  ["android-kotlin-constructor",[["relation","ownerName"]]],
  ["android-kotlin-enum-member",[["relation","ownerName","memberName"]]],
  ["android-kotlin-extends",[["relation","typeName","targetName"]]],
  ["android-kotlin-function",[["relation","functionName"]]],
  ["android-kotlin-implements",[["relation","typeName","targetName"]]],
  ["android-kotlin-import",[["relation","importedName","target","packageName","wildcard"],["relation","importedName","alias","target","packageName","wildcard"]]],
  ["android-kotlin-method",[["relation","ownerName","methodName"]]],
  ["android-kotlin-object",[["relation","objectName"]]],
  ["android-kotlin-override",[["relation","typeName","memberName","targetName"]]],
  ["android-kotlin-property",[["relation","ownerName","propertyName","isConst","isMutable","constructorParameter"],["relation","ownerName","propertyName","isConst","isMutable"]]],
  ["android-kotlin-resource-reference",[["relation","resourceType","resourceName"]]],
  ["android-kotlin-type-reference",[["relation","typeName","targetName","typeRole","parameterName"],["relation","typeName","targetName","typeRole"]]],
  ["android-manifest-component",[["relation","componentType","className","rawName","exported","actions"]]],
  ["android-manifest-component-permission",[["relation","componentType","className","permission"]]],
  ["android-manifest-intent-filter-action",[["relation","action"]]],
  ["android-manifest-intent-filter-category",[["relation","category"]]],
  ["android-manifest-intent-filter-data",[["relation","scheme","host"]]],
  ["android-manifest-query",[["relation","queryType","queryValue"],["relation","queryType","queryValue","actions","categories","data"]]],
  ["android-manifest-uses-permission",[["relation","permission","declarationType"]]],
  ["android-resource-reference",[["relation","resourceType","resourceName"]]],
  ["android-widget-provider",[["relation","componentType","className","resourceType","resourceName","manifestFile"]]],
  ["angular-app-provider",[["relation","provider","providerKind","bootstrapComponent","bootstrapLine","arguments","endLine"],["relation","provider","providerKind","bootstrapComponent","bootstrapLine","deps","endLine"],["relation","provider","providerKind","bootstrapComponent","bootstrapLine","useClass","deps","endLine"]]],
  ["angular-route-guard",[["relation","guardKind","path"]]],["angular-route-provider",[["relation","provider","path"]]],["angular-route-resolver",[["relation","resolverKey","path"]]],
  ["angular-route-redirect",[["relation","path","redirectTo","pathMatch"],["relation","path","redirectTo"]]],
  ["call",[["relation"]]],
  ["class-member",[["relation"]]],
  ["commonjs-export",[["relation","exportName","targetName"]]],
  ["commonjs-require",[["relation","importedName"]]],
  ["config-property",[["relation","configObject","configPath","configProperty"],["relation","configObject","configPath","parentConfigPath","configProperty"]]],
  ["config-source",[["relation","configKey","configObject","configProperty","configPath"]]],
  ["context7-category-doc",[["relation","category","docPath"]]],
  ["context7-retrieval-primary",[["relation","query","docPath"]]],
  ["context7-retrieval-secondary",[["relation","query","docPath"]]],
  ["context7-source-map-doc",[["relation","question","docPath"]]],
  ["context7-source-map-source",[["relation","question","sourcePath"]]],
  ["decorator",[["relation"]]],
  ["decorator-argument",[["relation"]]],
  ["dependency",[["relation","injectionKind","matchedNeedle"],["relation"]]],
  ["dynamic-import",[["relation"]]],
  ["edge-function-header",[["relation","header","normalizedHeader","sourceFile"]]],
  ["edge-function-invoke",[["relation","invokeName","path"]]],
  ["edge-function-method",[["relation","method","methodSource","sourceFile"]]],
  ["edge-function-route",[["relation","path","invokeName"]]],
  ["edge-function-source",[["relation","sourceFile"]]],
  ["enum-member",[["relation"]]],
  ["env-var",[["relation","envVar"]]],
  ["export",[["relation","exportName","isTypeOnly"],["relation","exportName"]]],
  ["export-equals",[["relation","exportName","isTypeOnly"],["relation","exportName"]]],
  ["extends",[["relation"]]],
  ["file-symbol",[["relation"]]],
  ["hard-rule",[["relation"]]],
  ["hard-rule-implementation",[["relation","keyword","matchedNeedle","call","requiredBy"]]],
  ["hard-rule-keyword",[["relation","keyword","keywordMapping","matchedNeedle","rule"]]],
  ["hard-rule-test-evidence",[["relation","keyword","matchedNeedle","call","requiredBy"]]],
  ["host-attribute",[["relation","api","attribute","value","kind"]]],
  ["host-binding",[["relation","api","binding","expression","kind"],["relation","api","binding"]]],["host-directive",[["relation","inputs","outputs"]]],
  ["host-listener",[["relation","api","event"],["relation","api","event","expression"]]],["jsx-component",[["relation"]]],
  ["implements",[["relation"]]],
  ["import",[["relation","importedName","isTypeOnly"],["relation","importedName"],["relation"]]],
  ["initializer-reference",[["relation"]]],
  ["input",[["relation","api"]]],
  ["interface-member",[["relation"]]],
  ["local-declaration",[["relation"]]],
  ["local-variable-type",[["relation"]]],
["migration-constraint",[["relation","constraintName","table","constraintType","constraintSource","columns","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","onDelete","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","onDelete","onDeleteColumns","onUpdate","onUpdateColumns","notValid"],["relation","constraintName","table",
    "constraintType","constraintSource","columns","referencedTable","referencedColumns","onUpdate","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","referencedTable","referencedColumns","matchType","onDelete","onUpdate","deferrable","initially","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","nullsDistinct","notValid"],["relation","constraintName","table","constraintType","constraintSource","columns","nullsDistinct","deferrable","initially","notValid"],["relation","constraintName","table","constraintType","constraintSource","expression","notValid"],["relation","constraintName","table","constraintType","constraintSource","indexMethod","excludeElements","predicate","notValid"],["relation","constraintName","table","constraintType","constraintSource","usingIndex","notValid"],["relation","constraintName","table","constraintType","constraintSource","usingIndex","deferrable","notValid"]]],
  ["migration-constraint-validation",[["relation","constraintName","table"]]],["model",[["relation","api"]]],
  ["migration-index",[["relation","indexName","table","columns","method","unique","concurrently"],["relation","indexName","table","columns","unique","concurrently","predicate"],["relation","indexName","table","columns","unique","concurrently"]]],
  ["migration-realtime-publication",[["relation","publication","action","table"]]],
  ["migration-rls",[["relation","table","action"]]],
  ["migration-view",[["relation","view","materialized"]]],
  ["namespace-member",[["relation"]]],
  ["nested-function",[["relation"]]],
  ["new",[["relation"]]],
  ["object-function",[["relation"]]],
  ["output",[["relation","api"]]],
  ["override",[["relation"]]],
  ["parameter",[["relation"]]],
  ["parameter-type",[["relation"]]],
  ["pipe-name",[["relation"]]],
  ["policy",[["relation"]]],
  ["policy-command",[["relation","policy","command"]]],
  ["policy-role",[["relation","policy","role"]]],
  ["policy-type",[["relation","policy","type"]]],
  ["policy-using",[["relation","policy","expression"]]],
  ["policy-with-check",[["relation","policy","expression"]]],
  ["privilege-grant",[["relation","action","privilege","objectType","objectName","role","grantOption"]]],
  ["privilege-object",[["relation","action","objectType","objectName","privileges","roles","grantOption"],["relation","action","objectType","objectName","privileges","roles","grantOptionFor"],["relation","action","objectType","objectName","privileges","roles","grantOptionFor","revokeBehavior"]]],
  ["privilege-revoke",[["relation","action","privilege","objectType","objectName","role","grantOptionFor"],["relation","action","privilege","objectType","objectName","role","grantOptionFor","revokeBehavior"]]],
  ["privilege-role",[["relation","action","role","privileges","objectType","objectNames","grantOption"],["relation","action","role","privileges","objectType","objectNames","grantOptionFor"],["relation","action","role","privileges","objectType","objectNames","grantOptionFor","revokeBehavior"]]],
  ["providedIn",[["relation"]]],
  ["provider",[["relation","matchedNeedle"]]],
  ["query",[["relation","api"]]],
  ["re-export",[["relation","exportName","isTypeOnly"],["relation","exportName"]]],
  ["return-type",[["relation"]]],
  ["risk-tag",[["relation","riskTag","riskSource"]]],
  ["route",[["relation","path","exportName"],["relation","path"],["relation"]]],
  ["signal",[["relation","api"]]],
  ["sql-function",[["relation","functionName","returnType","language","security"],["relation","functionName","returnType","language"],["relation","functionName","returnType","security"],["relation","functionName","returnType"]]],
  ["standalone-import",[["relation","matchedNeedle"]]],
  ["style-url",[["framework","relation","angularProperty","legacyRelation"]]],
  ["supabase-incremental-predicate",[["relation","table","operator","cursor","cursorKeyword","column"]]],
  ["supabase-realtime-channel",[["relation","channelName","owner"]]],
  ["supabase-realtime-postgres-change",[["relation","owner","channelName","event","schema","table","filter"]]],
  ["supabase-realtime-remove-all-channels",[["relation","action","owner"]]],
  ["supabase-realtime-remove-channel",[["relation","action","owner","channelName"],["relation","action","owner","channelName","channelVariable"],["relation","action","owner","channelVariable"]]],
  ["supabase-realtime-status",[["relation","status","action","owner"]]],
  ["supabase-realtime-unsubscribe",[["relation","action","owner","channelName"],["relation","action","owner","channelName","channelVariable"],["relation","action","owner","channelVariable"]]],
  ["supabase-rpc",[["relation","functionName","argNames"],["relation","functionName"]]],
  ["supabase-select-field",[["relation","field","table","selectConfig"],["relation","field","table","selectSource"],["relation","table","field","selectConfig"]]],
  ["supabase-storage-bucket",[["relation","bucket","storageSource","policy","table"],["relation","bucket","storageSource"]]],
  ["supabase-table-write",[["relation","table","writeOperation","optionKeys"],["relation","table","writeOperation","payloadKeys","optionKeys"],["relation","table","writeOperation","payloadKeys"],["relation","table","writeOperation"]]],
  ["sync-config-source",[["relation","configKey","configObject","configProperty","configPath"]]],
  ["sync-required-field",[["relation","field","table","requiredBy"]]],
  ["sync-required-predicate",[["relation","keyword","table","operator","cursor","requiredBy","column"]]],
  ["sync-rule",[["relation","ownerHeading"]]],
  ["sync-rule-keyword",[["relation","keyword","keywordMapping","matchedNeedle","ownerHeading"]]],
  ["table",[["relation"]]],
  ["template-binding",[["relation","bindingKind","binding","matchedNeedle"],["relation","bindingKind","binding","templateFile","matchedNeedle"],["relation","bindingKind","matchedNeedle"],["relation","bindingKind","templateFile","matchedNeedle"]]],
  ["template-component",[["relation","selector","element","matchedNeedle"],["relation","selector","element","templateFile","matchedNeedle"]]],
  ["template-directive",[["relation","selector","element","attribute","attributeValue","templateFile","matchedNeedle"],["relation","selector","element","attribute","attributeValue","matchedNeedle"],["relation","selector","element","attribute","templateFile","matchedNeedle"],["relation","selector","element","attribute","matchedNeedle"],["relation","selector","element","className","templateFile","matchedNeedle"],["relation","selector","element","className","matchedNeedle"],["relation","selector","element","templateFile","matchedNeedle"],["relation","selector","element","matchedNeedle"]]],
  ["template-pipe",[["relation","pipeName","matchedNeedle"],["relation","pipeName","templateFile","matchedNeedle"]]],
  ["template-url",[["framework","relation","angularProperty","legacyRelation"]]],
  ["test",[["relation","testMapping","matchedNeedle"],["relation","testMapping"]]],
  ["trigger",[["relation","trigger","table","timing","events"]]],
  ["trigger-function",[["relation","trigger","functionName"]]],
  ["type-literal-member",[["relation"]]],
  ["type-parameter-constraint",[["relation","typeParameter"]]],
  ["type-parameter-default",[["relation","typeParameter"]]],
  ["type-reference",[["relation"]]],
];
const NODE_RELATIONS_BY_KIND = [
  ["class",["android-kotlin-class","android-kotlin-companion-object","android-kotlin-object","android-manifest-component"]],
  ["enum",["android-kotlin-enum"]],
  ["enum_member",["android-kotlin-enum-member"]],
  ["export",["commonjs-export","export","export-equals","re-export"]],
  ["file",["android-kotlin-source","android-manifest","android-resource-file","angular-app-config","context7-doc","context7-source-path","dynamic-import-file","dynamic-import-target","edge-function-source","export-file","import","injector-file","re-export-file","route-target","source-file","style-url","template-url","test"]],
  ["function",["android-kotlin-function","sql-function"]],["interface",["android-kotlin-interface"]],
  ["import",["android-kotlin-import","commonjs-require","import"]],
  ["method",["android-kotlin-constructor","android-kotlin-method"]],
  ["namespace",["namespace-member"]],
  ["property",["android-kotlin-property","config-property","supabase-select-field"]],
  ["route",["edge-function-route"]],
["variable",["android-kotlin-annotation","android-kotlin-extends","android-kotlin-implements","android-kotlin-import","android-kotlin-override","android-kotlin-type-reference","android-manifest-intent-filter-value","android-manifest-permission","android-manifest-query","angular-app-provider","context7-category","context7-retrieval-route","context7-source-map-route","context7-source-path","decorator","decorator-argument","dependency","edge-function-header",
    "edge-function-method","env-var","extends","external-reference","hard-rule","hard-rule-keyword","host-attribute","implements","initializer-reference","migration-constraint","migration-index","migration-realtime-publication","migration-rls","migration-view","new","parameter-type","pipe-name","policy","privilege","privilege-object","privilege-role","providedIn","query","return-type","risk-tag","supabase-incremental-predicate",
    "supabase-realtime-channel","supabase-realtime-postgres-change","supabase-realtime-remove-all-channels","supabase-realtime-remove-channel","supabase-realtime-status","supabase-realtime-unsubscribe","supabase-rpc","supabase-storage-bucket","supabase-table-write","sync-rule","sync-rule-keyword","table","template-binding","trigger","trigger-function","type-reference"]],
];
const EDGE_RELATIONS_BY_KIND = [
  ["calls",["android-kotlin-call","call","host-listener","jsx-component","output","signal"]],
  ["contains",["android-kotlin-companion-object","android-kotlin-constructor","android-kotlin-enum-member","android-kotlin-function","android-kotlin-method","android-kotlin-object","android-kotlin-property","class-member","config-property","enum-member","file-symbol","interface-member","local-declaration","namespace-member","nested-function","object-function","parameter","supabase-select-field","type-literal-member"]],
  ["decorates",["android-kotlin-annotation","decorator","hard-rule","policy","providedIn","risk-tag","sync-rule"]],
  ["exports",["commonjs-export","export","export-equals","re-export"]],
  ["extends",["android-kotlin-extends","extends"]],
  ["implements",["android-kotlin-implements","implements"]],
  ["imports",["android-kotlin-import","android-resource-reference","commonjs-require","dynamic-import","edge-function-source","import","standalone-import","style-url","template-url"]],
  ["instantiates",["new"]],
  ["overrides",["android-kotlin-override","override"]],
["references",["android-kotlin-resource-reference","android-manifest-component","android-manifest-component-permission","android-manifest-intent-filter-action","android-manifest-intent-filter-category","android-manifest-intent-filter-data","android-manifest-query","android-manifest-uses-permission","android-widget-provider","angular-app-provider","angular-route-guard","angular-route-provider","angular-route-redirect","angular-route-resolver","config-source","context7-category-doc",
    "context7-retrieval-primary","context7-retrieval-secondary","context7-source-map-doc","context7-source-map-source","decorator-argument","edge-function-header","edge-function-invoke","edge-function-method","edge-function-route","env-var","hard-rule-implementation","hard-rule-keyword","hard-rule-test-evidence","host-attribute","host-binding","host-directive","initializer-reference","input","migration-constraint","migration-constraint-validation","migration-index",
    "migration-realtime-publication","migration-rls","migration-view","model","pipe-name","policy-command","policy-role","policy-type","policy-using","policy-with-check","privilege-grant","privilege-object","privilege-revoke","privilege-role","provider","query","route","sql-function","supabase-incremental-predicate","supabase-realtime-channel","supabase-realtime-postgres-change","supabase-realtime-remove-all-channels","supabase-realtime-remove-channel","supabase-realtime-status",
    "supabase-realtime-unsubscribe","supabase-rpc","supabase-select-field","supabase-storage-bucket","supabase-table-write","sync-config-source","sync-required-field","sync-required-predicate","sync-rule-keyword","table","template-binding","template-component","template-directive","template-pipe","test","trigger","trigger-function"]],
  ["returns",["return-type"]],
  ["type_of",["android-kotlin-type-reference","dependency","local-variable-type","parameter-type","type-parameter-constraint","type-parameter-default","type-reference"]],
];
for (const [schemaPath, groups] of [
  ['graph.nodes[]', NODE_ORDERS_BY_KIND], ['graph.edges[]', EDGE_ORDERS_BY_KIND],
  ['graph.nodes[].metadata', NODE_METADATA_ORDERS], ['graph.edges[].metadata', EDGE_METADATA_ORDERS],
]) {
  const orders = OBJECT_RULES.find(([path]) => path === schemaPath)[2];
  const known = new Set(orders.map(JSON.stringify));
  for (const [, variants] of groups) for (const order of variants) if (!known.has(JSON.stringify(order))) orders.push(order);
}
function createGraphRuntime({ contract, canonicalJson, canonicalRepositoryPath, fail, runtimeIntl, runtimeIcuVersion }) {
  const shapeRules = rows => new Map(rows.map(([relation, shapes]) => [
    relation,
    new Set(shapes.map(shape => JSON.stringify(shape))),
  ]));
  const relationRules = rows => new Map(rows.map(([kind, relations]) => [kind, new Set(relations)]));
  const nodeMetadataShapes = shapeRules(NODE_METADATA_ORDERS);
  const edgeMetadataShapes = shapeRules(EDGE_METADATA_ORDERS);
  const nodeRelationsByKind = relationRules(NODE_RELATIONS_BY_KIND);
  const edgeRelationsByKind = relationRules(EDGE_RELATIONS_BY_KIND);
  const nodeKinds = new Set(NODE_KINDS);
  const edgeKinds = new Set(EDGE_KINDS);
  const languages = new Set(LANGUAGES);
  const visibilities = new Set(VISIBILITIES);
  const nodeOrdersByKind = new Map(NODE_ORDERS_BY_KIND);
  const edgeOrdersByKind = new Map(EDGE_ORDERS_BY_KIND);
  const linePaths = new Set(contract.coordinatePolicy.linePaths);
  const columnPaths = new Set(contract.coordinatePolicy.columnPaths);
  const repositoryFileFields = new Set(contract.pathPolicy.graphRepositoryFileFields);
  const repositoryDirectoryFields = new Set(contract.pathPolicy.graphRepositoryDirectoryFields);
  const nodeIdSpecialRules = new Map(Object.entries(contract.nodeIdentity.specialRelations));
  const ordering = contract.graphOrdering;
  const collator = new runtimeIntl.Collator(ordering.locale, ordering.options);
  if (ordering.algorithm !== 'pinned-icu-collator-v1'
    || runtimeIcuVersion !== ordering.icuVersion
    || new runtimeIntl.Collator().resolvedOptions().locale !== ordering.producerDefaultLocale
    || canonicalJson(collator.resolvedOptions()) !== canonicalJson(ordering.resolvedOptions)) {
    fail('OVERLAY_SCHEMA_ORDERING_RUNTIME_MISMATCH');
  }
  function exactOrder(orders, sequence) {
    return orders?.some(order => (
      order.length === sequence.length && order.every((key, index) => key === sequence[index])
    ));
  }
  function validateMetadata(metadata, kind, shapes, relations, schemaPath) {
    if (!metadata) return;
    const relation = metadata.relation;
    if (relation !== undefined && !relations.get(kind)?.has(relation)) {
      fail('OVERLAY_SCHEMA_RELATION_KIND', schemaPath);
    }
    if (!shapes.get(relation ?? `@none:${kind}`)?.has(JSON.stringify(Object.keys(metadata)))) {
      fail('OVERLAY_SCHEMA_UNKNOWN_KEY', schemaPath);
    }
  }
  function isExternalPath(value) {
    if (typeof value !== 'string' || value.includes('\\')
      || value.split('/').some(segment => segment === '.' || segment === '..')) return false;
    if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[!-~]+$/.test(value) || /^node:[a-z0-9_./-]+$/i.test(value)) {
      return true;
    }
    return !/^(?:src|scripts|docs|android|supabase|public|e2e|\.github)\//.test(value)
      && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_][a-z0-9_.-]*(?:\/[a-z0-9_.-]+)*$/i.test(value);
  }
  function qualifiedIdentityMatches(qualified, suffix) {
    let qualifiedOffset = 0;
    let suffixOffset = 0;
    let dotted = false;
    while (true) {
      const separator = qualified.indexOf('::', qualifiedOffset);
      const end = separator < 0 ? qualified.length : separator;
      const part = qualified.slice(qualifiedOffset, end);
      if (!suffix.startsWith(part, suffixOffset)) return false;
      suffixOffset += part.length;
      if (separator < 0) return suffixOffset === suffix.length;
      if (!dotted && suffix.startsWith('::', suffixOffset)) suffixOffset += 2;
      else if (suffix[suffixOffset] === '.') { dotted = true; suffixOffset += 1; }
      else return false;
      qualifiedOffset = end + 2;
    }
  }
  function compositeIdentityMatches(node, suffix, relation) {
    const metadata = node.metadata ?? {};
    const name = String(node.name);
    const line = node.startLine ?? '';
    const lineOrUnknown = node.startLine ?? 'unknown-line';
    if (['import', 'commonjs-require', 'android-kotlin-import'].includes(relation)) {
      return suffix === `${name}:${metadata.target ?? ''}:${metadata.importedName ?? ''}:${line}`;
    }
    if (['export', 'export-equals', 'commonjs-export', 're-export'].includes(relation)) {
      return suffix === `${metadata.exportName ?? metadata.name ?? name}:${metadata.target ?? ''}:${line}`;
    }
    const templates = {
      'hard-rule-keyword': `hard-rule-keyword:${metadata.rule}:${name}`,
      'sync-rule': `sync-rule:${metadata.ownerHeading}:${name}`,
      'sync-rule-keyword': `sync-rule-keyword:${metadata.ownerHeading}:${metadata.rule}:${name}`,
      'android-manifest-intent-filter-value': `android-intent-${metadata.valueType}:${name}`,
      'android-manifest-permission': `android-permission:${metadata.permission}`,
      'android-manifest-query': `android-manifest-query:${metadata.queryType}:${metadata.queryValue}`,
      'context7-category': `context7-category:${metadata.category}`,
      'context7-source-path': `context7-source-path:${metadata.sourcePath}`,
      'supabase-rpc': `supabase-rpc:${metadata.functionName}`,
      'supabase-realtime-channel': `supabase-realtime-channel:${metadata.owner}:${metadata.channelName}:${lineOrUnknown}`,
      'edge-function-method': `edge-function-method:${metadata.functionName}:${metadata.method}:${line}`,
      privilege: `privilege:${metadata.action}:${metadata.privilege}:${metadata.objectType}:${lineOrUnknown}`,
      'privilege-role': `privilege-role:${metadata.action}:${metadata.role}:${lineOrUnknown}`,
      trigger: `${name}:${metadata.table ?? 'unknown-table'}:${lineOrUnknown}`,
      'migration-constraint': `constraint:${name}:${metadata.table ?? 'unknown-table'}:${lineOrUnknown}`,
      'privilege-object': `privilege-object:${metadata.action}:${metadata.objectType}:${metadata.objectName}:${lineOrUnknown}`,
      'migration-view': `migration-view:${metadata.view}:${lineOrUnknown}`,
    };
    if (relation === 'supabase-storage-bucket') {
      return suffix === `supabase-storage-bucket:${metadata.bucket}`
        || suffix === `supabase-storage-bucket:${metadata.bucket}:policy:${metadata.policy}:${lineOrUnknown}`;
    }
    return suffix === templates[relation];
  }
  function nodeIdentityMatches(node, suffix) {
    const qualified = String(node.qualifiedName ?? '');
    const name = String(node.name);
    if ((name && suffix === name) || (qualified && qualifiedIdentityMatches(qualified, suffix))) return true;
    const relation = node.metadata?.relation;
    const rule = nodeIdSpecialRules.get(relation);
    if (rule) {
      const value = token => token === '@relation' ? relation
        : token === '@schemaTable' ? `${node.metadata.schema}.${node.metadata.table}`
            : token === '@startLine' ? node.startLine
              : token === '@channelScope' ? node.metadata.channelName ?? node.metadata.channelVariable
            : token === '@qualifiedOwner' ? qualified.split('::')[0]
              : node.metadata[token];
      if (rule.at(-1) === '@index') {
        const prefix = `${rule.slice(0, -1).map(value).join(':')}:`;
        if (suffix.startsWith(prefix) && /^(?:0|[1-9]\d*)$/.test(suffix.slice(prefix.length))) return true;
      } else if (suffix === rule.map(value).join(':')) return true;
    }
    return compositeIdentityMatches(node, suffix, relation);
  }
  function compareTuple(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      const compared = collator.compare(left[index], right[index]);
      if (compared) return compared;
    }
    return 0;
  }
  function trackOrder(state, label, value, keys, schemaPath) {
    const tuple = keys.map(key => String(value[key]));
    const prior = state.orderState[label];
    const comparison = prior ? compareTuple(prior.tuple, tuple) : -1;
    if (comparison > 0) fail('OVERLAY_SCHEMA_ARRAY_ORDER', schemaPath);
    const prefix = label === 'node' ? 'node' : 'edge';
    const size = comparison === 0 ? prior.size + 1 : 1;
    if (size === 2) state.counts[`${prefix}TieGroups`] += 1;
    if (size > 1) state.counts[`${prefix}TieExtraItems`] += 1;
    state.counts[`${prefix}MaxTieGroup`] = Math.max(state.counts[`${prefix}MaxTieGroup`], size > 1 ? size : 0);
    state.orderState[label] = { tuple, size };
  }
  function validateNode(state, node, sequence) {
    if (!nodeKinds.has(node.kind)) fail('OVERLAY_SCHEMA_VALUE', 'graph.nodes[].kind');
    if (!exactOrder(nodeOrdersByKind.get(node.kind), sequence)) fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON', 'graph.nodes[]');
    if (!languages.has(node.language)) fail('OVERLAY_SCHEMA_VALUE', 'graph.nodes[].language');
    if (node.visibility !== undefined && !visibilities.has(node.visibility)) {
      fail('OVERLAY_SCHEMA_VALUE', 'graph.nodes[].visibility');
    }
    const normalized = canonicalRepositoryPath(node.filePath, false);
    if ((!normalized && !isExternalPath(node.filePath))
      || (normalized && node.metadata?.relation === 'source-file' && !state.selectedSources.has(normalized))) {
      fail('OVERLAY_SCHEMA_INVALID_PATH', 'graph.nodes[].filePath');
    }
    const idBytes = typeof node.id === 'string' ? Buffer.byteLength(node.id) : 0;
    const idPrefix = `${node.kind}:${node.filePath}:`;
    if (typeof node.id !== 'string' || !node.id.startsWith(idPrefix)
      || !nodeIdentityMatches(node, node.id.slice(idPrefix.length))) {
      fail('OVERLAY_SCHEMA_INVALID_ID', 'graph.nodes[].id');
    }
    if (state.nodeIds.has(node.id)) fail('OVERLAY_SCHEMA_DUPLICATE_ID', 'graph.nodes[]');
    state.counts.endpointIdBytes += idBytes;
    if (state.nodeIds.size >= state.limits.endpointIds || idBytes > state.limits.singleEndpointIdBytes
      || state.counts.endpointIdBytes > state.limits.endpointIdBytes) fail('OVERLAY_SCHEMA_LIMIT', 'graph.nodes[].id');
    state.recordGraphPath(node.filePath);
    if (node.updatedAt !== Date.parse(state.generatedAt)) fail('OVERLAY_SCHEMA_VALUE', 'graph.nodes[].updatedAt');
    if (node.endLine < node.startLine || (node.endLine === node.startLine && node.endColumn < node.startColumn)) {
      fail('OVERLAY_SCHEMA_VALUE', 'graph.nodes[]');
    }
    validateMetadata(node.metadata, node.kind, nodeMetadataShapes, nodeRelationsByKind, 'graph.nodes[].metadata');
    state.nodeIds.add(node.id);
    trackOrder(state, 'node', node, contract.graphOrdering.nodes.keys, 'graph.nodes');
    state.counts.graphNodes += 1;
  }
  function validateEdge(state, edge, sequence) {
    if (!edgeKinds.has(edge.kind)) fail('OVERLAY_SCHEMA_VALUE', 'graph.edges[].kind');
    if (!exactOrder(edgeOrdersByKind.get(edge.kind), sequence)) fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON', 'graph.edges[]');
    if (!state.nodeIds.has(edge.source) || !state.nodeIds.has(edge.target)) fail('OVERLAY_SCHEMA_DANGLING_EDGE', 'graph.edges[]');
    validateMetadata(edge.metadata, edge.kind, edgeMetadataShapes, edgeRelationsByKind, 'graph.edges[].metadata');
    trackOrder(state, 'edge', edge, contract.graphOrdering.edges.keys, 'graph.edges');
    state.counts.graphEdges += 1;
  }
  const staticCounts = deepFreeze({
    nodeKinds: nodeKinds.size,
    edgeKinds: edgeKinds.size,
    relations: new Set([...nodeRelationsByKind.values(), ...edgeRelationsByKind.values()].flatMap(set => [...set])).size,
    nodeMetadataShapes: new Set([...nodeMetadataShapes.values()].flatMap(set => [...set])).size,
    edgeMetadataShapes: new Set([...edgeMetadataShapes.values()].flatMap(set => [...set])).size,
  });
  return Object.freeze({
    staticCounts,
    isLinePath: schemaPath => linePaths.has(schemaPath),
    isColumnPath: schemaPath => columnPaths.has(schemaPath),
    repositoryPathKind: schemaPath => repositoryDirectoryFields.has(schemaPath)
      ? 'directory' : repositoryFileFields.has(schemaPath) ? 'file' : null,
    validateNode,
    validateEdge,
  });
}
const DESCRIPTOR_DIGEST = "d351740e73e31bca9cb065ca104c5840275b7ed00d19bca5aa5c4088812f316a";
const DESCRIPTOR = {
  name: "graph",
  descriptorDigest: DESCRIPTOR_DIGEST,
  objectRules: OBJECT_RULES,
  arrayPaths: ARRAY_PATHS,
  scalarTypeGroups: SCALAR_TYPE_GROUPS,
  nodeKinds: NODE_KINDS,
  edgeKinds: EDGE_KINDS,
  languages: LANGUAGES,
  visibilities: VISIBILITIES,
  nodeOrdersByKind: NODE_ORDERS_BY_KIND,
  edgeOrdersByKind: EDGE_ORDERS_BY_KIND,
  nodeMetadataOrders: NODE_METADATA_ORDERS,
  edgeMetadataOrders: EDGE_METADATA_ORDERS,
  nodeRelationsByKind: NODE_RELATIONS_BY_KIND,
  edgeRelationsByKind: EDGE_RELATIONS_BY_KIND,
};
Object.defineProperty(DESCRIPTOR, 'createRuntime', {
  value: Object.freeze(createGraphRuntime),
  enumerable: false,
});
module.exports = deepFreeze(DESCRIPTOR);
