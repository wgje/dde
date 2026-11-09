'use strict';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const OBJECT_RULES = [
  ["typescript",["classes","enums","exports","files","functions","imports","interfaces","namespaces","parameters","types","variables"],[["files","classes","functions","interfaces","types","variables","enums","namespaces","imports","exports","parameters"]]],
["typescript.classes[]",["className","decorators","docstring","endColumn","endLine","extends","file","implements","instantiates","isAbstract","isDefaultExport","isExported","jsxReferences","line","localDeclarationOwnerKind","localDeclarationOwnerQualifiedName","methods","properties",
    "qualifiedName","signature","startColumn","startLine","typeParameterReferences","typeParameters","typeReferences","valueReferences"],[["className","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","isAbstract","decorators",
    "typeParameters","typeParameterReferences","methods","properties","extends","implements","instantiates","typeReferences","valueReferences"],["className","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAbstract","typeParameters",
    "typeParameterReferences","methods","properties","extends","implements","instantiates","typeReferences"],["className","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","isAbstract","decorators","typeParameters",
    "typeParameterReferences","methods","properties","extends","implements","instantiates","typeReferences","valueReferences","jsxReferences","localDeclarationOwnerQualifiedName","localDeclarationOwnerKind"]]],
  ["typescript.classes[].decorators[]",["argumentReferences","column","line","name"],[["name","line","column","argumentReferences"]]],
["typescript.classes[].methods[]",["calls","decorators","docstring","endColumn","endLine","hardRuleImplementationCalls","hasBody","instantiates","isAbstract","isAsync","isOverride","isStatic","jsxReferences","line","localDeclarations","name","parameters","returns","signature","startColumn",
    "startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls","supabaseSelects","supabaseStorageBuckets","supabaseTableWrites",
    "typeParameterReferences","typeParameters","typeReferences","valueReferences","visibility"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync","isStatic","isAbstract","isOverride","visibility","decorators","returns","typeParameters",
    "typeParameterReferences","parameters","typeReferences","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","hasBody","localDeclarations"],["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync","isStatic","isAbstract","isOverride",
    "visibility","decorators","returns","typeParameters","typeParameterReferences","typeReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls",
    "supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","localDeclarations"],["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync",
    "isStatic","isAbstract","isOverride","visibility","decorators","typeParameters","typeParameterReferences","typeReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes",
    "supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","localDeclarations"]]],
  ["typescript.classes[].methods[].decorators[]",["argumentReferences","column","line","name"],[["name","line","column","argumentReferences"]]],
  ["typescript.classes[].methods[].hardRuleImplementationCalls[]",["call","column","keyword","line"],[["keyword","call","line","column"]]],
  ["typescript.classes[].methods[].localDeclarations",["classes","enums","interfaces","types"],[["classes","interfaces","types","enums"]]],
["typescript.classes[].methods[].localDeclarations.types[]",["docstring","endColumn","endLine","file","isDefaultExport","isExported","line","localDeclarationOwnerKind","localDeclarationOwnerQualifiedName","methods","name","properties","qualifiedName","signature","startColumn","startLine",
    "typeParameterReferences","typeParameters","typeReferences"],[["name","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","typeReferences",
    "localDeclarationOwnerQualifiedName","localDeclarationOwnerKind"]]],
["typescript.classes[].methods[].localDeclarations.types[].methods[]",["calls","docstring","endColumn","endLine","instantiates","line","name","parameters","returns","signature","startColumn","startLine","typeParameterReferences","typeParameters","typeReferences"],[["name","line","startLine",
    "endLine","startColumn","endColumn","docstring","signature","returns","typeParameters","typeParameterReferences","typeReferences","parameters","calls","instantiates"]]],
  ["typescript.classes[].methods[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences"]]],
  ["typescript.classes[].methods[].supabaseFunctionInvokes[]",["column","invokeName","line","path"],[["invokeName","path","line","column"]]],
  ["typescript.classes[].methods[].supabaseIncrementalPredicates[]",["column","columnNumber","cursor","cursorKeyword","line","name","operator","table"],[["name","table","column","operator","cursor","cursorKeyword","line","columnNumber"]]],
  ["typescript.classes[].methods[].supabaseRealtimeChannels[]",["channelName","column","line"],[["channelName","line","column"]]],
  ["typescript.classes[].methods[].supabaseRealtimeLifecycleActions[]",["action","channelVariable","column","line","relation"],[["relation","action","channelVariable","line","column"]]],
  ["typescript.classes[].methods[].supabaseRealtimePostgresChanges[]",["channelName","column","event","filter","line","schema","table"],[["channelName","event","schema","table","filter","line","column"]]],
  ["typescript.classes[].methods[].supabaseRealtimeStatuses[]",["action","column","line","status"],[["status","action","line","column"]]],
  ["typescript.classes[].methods[].supabaseRpcCalls[]",["argNames","column","functionName","line"],[["functionName","argNames","line","column"]]],
  ["typescript.classes[].methods[].supabaseSelects[]",["column","fields","line","selectConfig","table"],[["fields","table","line","column"],["selectConfig","fields","table","line","column"]]],
  ["typescript.classes[].methods[].supabaseTableWrites[]",["column","line","optionKeys","payloadKeys","table","writeOperation"],[["table","writeOperation","payloadKeys","optionKeys","line","column"]]],
  ["typescript.classes[].methods[].typeParameterReferences[]",["relation","target","typeParameter"],[["relation","typeParameter","target"]]],
["typescript.classes[].properties[]",["calls","decorators","docstring","endColumn","endLine","hardRuleImplementationCalls","instantiates","isAbstract","isOverride","isStatic","jsxReferences","line","name","returns","signature","startColumn","startLine","supabaseFunctionInvokes",
    "supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls","supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeReferences","valueReferences","visibility"],[["name",
    "line","startLine","endLine","startColumn","endColumn","docstring","signature","isStatic","isAbstract","isOverride","visibility","decorators","returns","typeReferences","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets",
    "supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences"],["name","line","startLine","endLine","startColumn","endColumn","docstring",
    "signature","isStatic","isAbstract","visibility","returns","typeReferences","calls","instantiates"]]],
  ["typescript.classes[].properties[].decorators[]",["argumentReferences","column","line","name"],[["name","line","column","argumentReferences"]]],
  ["typescript.classes[].properties[].hardRuleImplementationCalls[]",["call","column","keyword","line"],[["keyword","call","line","column"]]],
  ["typescript.classes[].typeParameterReferences[]",["relation","target","typeParameter"],[["relation","typeParameter","target"]]],
  ["typescript.enums[]",["docstring","endColumn","endLine","file","isDefaultExport","isExported","line","members","name","signature","startColumn","startLine"],[["name","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","members"]]],
  ["typescript.enums[].members[]",["docstring","endColumn","endLine","line","name","signature","startColumn","startLine"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature"]]],
["typescript.exports[]",["exportName","file","isTypeOnly","line","name","relation","target","targetName"],[["file","name","exportName","target","line","relation"],["file","name","targetName","exportName","target","line","relation"],["file","target","line","relation","isTypeOnly","name",
    "exportName"]]],
  ["typescript.files[]",["file","language"],[["file","language"]]],
["typescript.functions[]",["calls","configProperties","decorators","docstring","endColumn","endLine","file","hardRuleImplementationCalls","hasBody","instantiates","isAsync","isConst","isDefaultExport","isExported","jsxReferences","line","localDeclarations","localTypeReferences","name",
    "nestedFunctions","nestedOwnerQualifiedName","objectOwnerKind","objectOwnerName","objectOwnerQualifiedName","overloadSignatures","overloads","parameters","qualifiedName","returns","signature","startColumn","startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates",
    "supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls","supabaseSelectFields","supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeParameterReferences","typeParameters","typeReferences",
    "valueReferences"],[["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls",
    "supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences",
    "nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isConst","configProperties","supabaseSelectFields","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody",
    "decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isDefaultExport","overloadSignatures"],["name","file","qualifiedName","line","startLine",
    "endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets",
    "supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences",
    "nestedOwnerQualifiedName","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls",
    "hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses",
    "instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isConst","configProperties","supabaseSelectFields","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature",
    "isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls",
    "supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isDefaultExport","overloadSignatures"],["name",
    "file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects",
    "supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions",
    "localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences",
    "parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges",
    "supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isConst","configProperties","supabaseSelectFields","overloadSignatures"],["name","file","qualifiedName","line","startLine",
    "endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets",
    "supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences",
    "isDefaultExport","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls",
    "supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences",
    "nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isDefaultExport","overloads","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters",
    "typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges",
    "supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn",
    "endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes",
    "supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","overloads",
    "overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls",
    "supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences",
    "nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isConst","configProperties","supabaseSelectFields","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","returns",
    "decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","isDefaultExport","overloadSignatures"],["name","file","qualifiedName","line","startLine",
    "endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets",
    "supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences",
    "nestedOwnerQualifiedName","overloadSignatures"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls",
    "hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses",
    "instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","overloads","overloadSignatures"],["name","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","decorators",
    "typeParameters","typeParameterReferences","parameters","typeReferences","valueReferences","calls","hardRuleImplementationCalls","instantiates","jsxReferences","objectOwnerName","objectOwnerQualifiedName","objectOwnerKind","overloadSignatures"],["name","qualifiedName","file","line","startLine",
    "endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","typeParameters","typeParameterReferences","parameters","typeReferences","valueReferences","calls","hardRuleImplementationCalls","instantiates","jsxReferences","objectOwnerName","objectOwnerQualifiedName",
    "objectOwnerKind","overloadSignatures"],["name","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","typeReferences","valueReferences","calls",
    "hardRuleImplementationCalls","instantiates","jsxReferences","objectOwnerName","objectOwnerQualifiedName","objectOwnerKind","overloadSignatures"],["name","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","returns","decorators",
    "typeParameters","typeParameterReferences","parameters","typeReferences","valueReferences","calls","hardRuleImplementationCalls","instantiates","jsxReferences","objectOwnerName","objectOwnerQualifiedName","objectOwnerKind","overloadSignatures"],["name","qualifiedName","file","line","startLine",
    "endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","typeParameters","typeParameterReferences","parameters","typeReferences","valueReferences","calls","hardRuleImplementationCalls","instantiates","jsxReferences","objectOwnerName","objectOwnerQualifiedName",
    "objectOwnerKind","overloadSignatures"]]],
  ["typescript.functions[].hardRuleImplementationCalls[]",["call","column","keyword","line"],[["keyword","call","line","column"]]],
  ["typescript.functions[].localDeclarations",["classes","enums","interfaces","types"],[["classes","interfaces","types","enums"]]],
["typescript.functions[].localDeclarations.classes[]",["className","decorators","docstring","endColumn","endLine","extends","file","implements","instantiates","isAbstract","isDefaultExport","isExported","jsxReferences","line","localDeclarationOwnerKind","localDeclarationOwnerQualifiedName",
    "methods","properties","qualifiedName","signature","startColumn","startLine","typeParameterReferences","typeParameters","typeReferences","valueReferences"],[["className","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported",
    "isDefaultExport","isAbstract","decorators","typeParameters","typeParameterReferences","methods","properties","extends","implements","instantiates","typeReferences","valueReferences","jsxReferences","localDeclarationOwnerQualifiedName","localDeclarationOwnerKind"]]],
["typescript.functions[].localDeclarations.classes[].methods[]",["calls","decorators","docstring","endColumn","endLine","hardRuleImplementationCalls","hasBody","instantiates","isAbstract","isAsync","isOverride","isStatic","jsxReferences","line","localDeclarations","name","parameters","returns",
    "signature","startColumn","startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls","supabaseSelects","supabaseStorageBuckets",
    "supabaseTableWrites","typeParameterReferences","typeParameters","typeReferences","valueReferences","visibility"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync","isStatic","isAbstract","isOverride","visibility","decorators","returns",
    "typeParameters","typeParameterReferences","parameters","typeReferences","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","hasBody","localDeclarations"],["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","isAsync","isStatic","isAbstract","isOverride",
    "visibility","decorators","typeParameters","typeParameterReferences","typeReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites",
    "supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","localDeclarations"]]],
  ["typescript.functions[].localDeclarations.classes[].methods[].localDeclarations",["classes","enums","interfaces","types"],[["classes","interfaces","types","enums"]]],
["typescript.functions[].localDeclarations.classes[].methods[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns",
    "typeReferences"]]],
["typescript.functions[].localDeclarations.classes[].properties[]",["calls","decorators","docstring","endColumn","endLine","hardRuleImplementationCalls","instantiates","isAbstract","isOverride","isStatic","jsxReferences","line","name","returns","signature","startColumn","startLine",
    "supabaseFunctionInvokes","supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls","supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeReferences","valueReferences",
    "visibility"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","isStatic","isAbstract","isOverride","visibility","decorators","returns","typeReferences","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates",
    "supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences"],["name","line","startLine","endLine","startColumn",
    "endColumn","docstring","signature","isStatic","isAbstract","visibility","returns","typeReferences","calls","instantiates"]]],
["typescript.functions[].localDeclarations.types[]",["docstring","endColumn","endLine","file","isDefaultExport","isExported","line","localDeclarationOwnerKind","localDeclarationOwnerQualifiedName","methods","name","properties","qualifiedName","signature","startColumn","startLine",
    "typeParameterReferences","typeParameters","typeReferences"],[["name","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","typeReferences",
    "localDeclarationOwnerQualifiedName","localDeclarationOwnerKind"]]],
["typescript.functions[].localDeclarations.types[].properties[]",["calls","docstring","endColumn","endLine","instantiates","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature",
    "returns","typeReferences","calls","instantiates"]]],
["typescript.functions[].nestedFunctions[]",["calls","decorators","docstring","endColumn","endLine","file","hardRuleImplementationCalls","hasBody","instantiates","isAsync","isExported","jsxReferences","line","localDeclarations","localTypeReferences","name","nestedFunctions",
    "nestedOwnerQualifiedName","parameters","qualifiedName","returns","signature","startColumn","startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses",
    "supabaseRpcCalls","supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeParameterReferences","typeParameters","typeReferences","valueReferences"],[["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync",
    "hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites",
    "supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName"],["name","file","qualifiedName","line",
    "startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isAsync","hasBody","returns","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates",
    "supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations",
    "localTypeReferences","typeReferences","nestedOwnerQualifiedName"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators","typeParameters","typeParameterReferences","parameters","valueReferences","calls",
    "hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses",
    "instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","returns","decorators",
    "typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName"]]],
  ["typescript.functions[].nestedFunctions[].hardRuleImplementationCalls[]",["call","column","keyword","line"],[["keyword","call","line","column"]]],
  ["typescript.functions[].nestedFunctions[].localDeclarations",["classes","enums","interfaces","types"],[["classes","interfaces","types","enums"]]],
["typescript.functions[].nestedFunctions[].nestedFunctions[]",["calls","decorators","endColumn","endLine","file","hardRuleImplementationCalls","hasBody","instantiates","isAsync","isExported","jsxReferences","line","localDeclarations","localTypeReferences","name","nestedFunctions",
    "nestedOwnerQualifiedName","parameters","qualifiedName","signature","startColumn","startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls",
    "supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeParameterReferences","typeParameters","typeReferences","valueReferences"],[["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators",
    "typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName"]]],
  ["typescript.functions[].nestedFunctions[].nestedFunctions[].localDeclarations",["classes","enums","interfaces","types"],[["classes","interfaces","types","enums"]]],
["typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[]",["calls","decorators","endColumn","endLine","file","hardRuleImplementationCalls","hasBody","instantiates","isAsync","isExported","jsxReferences","line","localDeclarations","localTypeReferences","name","nestedFunctions",
    "nestedOwnerQualifiedName","parameters","qualifiedName","signature","startColumn","startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates","supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls",
    "supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeParameterReferences","typeParameters","typeReferences","valueReferences"],[["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","signature","isExported","isAsync","hasBody","decorators",
    "typeParameters","typeParameterReferences","parameters","valueReferences","calls","hardRuleImplementationCalls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels",
    "supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences","nestedFunctions","localDeclarations","localTypeReferences","typeReferences","nestedOwnerQualifiedName"]]],
  ["typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].localDeclarations",["classes","enums","interfaces","types"],[["classes","interfaces","types","enums"]]],
["typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature",
    "returns","typeReferences"]]],
["typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns",
    "typeReferences"]]],
  ["typescript.functions[].nestedFunctions[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences"]]],
  ["typescript.functions[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences"]]],
  ["typescript.functions[].supabaseRealtimeChannels[]",["channelName","column","line"],[["channelName","line","column"]]],
  ["typescript.functions[].supabaseRealtimeLifecycleActions[]",["action","channelVariable","column","line","relation"],[["relation","action","channelVariable","line","column"]]],
  ["typescript.functions[].supabaseRpcCalls[]",["argNames","column","functionName","line"],[["functionName","argNames","line","column"]]],
  ["typescript.functions[].supabaseSelects[]",["column","fields","line","table"],[["fields","table","line","column"]]],
  ["typescript.functions[].supabaseStorageBuckets[]",["bucket","column","line"],[["bucket","line","column"]]],
  ["typescript.functions[].supabaseTableWrites[]",["column","line","optionKeys","payloadKeys","table","writeOperation"],[["table","writeOperation","payloadKeys","optionKeys","line","column"]]],
  ["typescript.functions[].typeParameterReferences[]",["relation","target","typeParameter"],[["relation","typeParameter","target"]]],
  ["typescript.imports[]",["file","importedName","isTypeOnly","line","name","relation","target"],[["file","name","importedName","target","line","isTypeOnly"],["file","name","target","line"],["file","target","line","relation","name","importedName"]]],
["typescript.interfaces[]",["docstring","endColumn","endLine","extends","file","isDefaultExport","isExported","line","methods","name","properties","qualifiedName","signature","startColumn","startLine","typeParameterReferences","typeParameters","typeReferences"],[["name","file","line","startLine",
    "endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","extends","typeReferences"],["name","qualifiedName","file","line","startLine","endLine","startColumn","endColumn","docstring","signature",
    "isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","extends","typeReferences"]]],
["typescript.interfaces[].methods[]",["calls","docstring","endColumn","endLine","instantiates","line","name","parameters","returns","signature","startColumn","startLine","typeParameterReferences","typeParameters","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn",
    "docstring","signature","returns","typeParameters","typeParameterReferences","typeReferences","parameters","calls","instantiates"]]],
  ["typescript.interfaces[].methods[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences"]]],
["typescript.interfaces[].properties[]",["calls","docstring","endColumn","endLine","instantiates","line","name","parameters","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns",
    "typeReferences","calls","instantiates"],["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences","parameters","calls","instantiates"]]],
  ["typescript.interfaces[].properties[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences"]]],
  ["typescript.interfaces[].typeParameterReferences[]",["relation","target","typeParameter"],[["relation","typeParameter","target"]]],
  ["typescript.namespaces[]",["docstring","endColumn","endLine","file","isExported","line","members","name","signature","startColumn","startLine"],[["name","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","members"]]],
  ["typescript.namespaces[].members[]",["endColumn","endLine","kind","line","name","startColumn","startLine"],[["kind","name","line","startLine","endLine","startColumn","endColumn"]]],
["typescript.types[]",["docstring","endColumn","endLine","file","isDefaultExport","isExported","line","localDeclarationOwnerKind","localDeclarationOwnerQualifiedName","methods","name","properties","qualifiedName","signature","startColumn","startLine","typeParameterReferences","typeParameters",
    "typeReferences"],[["name","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","typeReferences"],["name","qualifiedName","file","line","startLine","endLine",
    "startColumn","endColumn","docstring","signature","isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","typeReferences","localDeclarationOwnerQualifiedName","localDeclarationOwnerKind"],["name","qualifiedName","file","line","startLine","endLine",
    "startColumn","endColumn","docstring","signature","isExported","isDefaultExport","typeParameters","typeParameterReferences","methods","properties","typeReferences"]]],
["typescript.types[].methods[]",["calls","docstring","endColumn","endLine","instantiates","line","name","parameters","returns","signature","startColumn","startLine","typeParameterReferences","typeParameters","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn",
    "docstring","signature","returns","typeParameters","typeParameterReferences","typeReferences","parameters","calls","instantiates"]]],
  ["typescript.types[].methods[].parameters[]",["docstring","endColumn","endLine","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences"]]],
["typescript.types[].properties[]",["calls","docstring","endColumn","endLine","instantiates","line","name","returns","signature","startColumn","startLine","typeReferences"],[["name","line","startLine","endLine","startColumn","endColumn","docstring","signature","returns","typeReferences","calls",
    "instantiates"]]],
  ["typescript.types[].typeParameterReferences[]",["relation","target","typeParameter"],[["relation","typeParameter","target"]]],
["typescript.variables[]",["calls","configProperties","docstring","endColumn","endLine","file","instantiates","isConst","isExported","jsxReferences","line","name","qualifiedName","returns","signature","startColumn","startLine","supabaseFunctionInvokes","supabaseIncrementalPredicates",
    "supabaseRealtimeChannels","supabaseRealtimeLifecycleActions","supabaseRealtimePostgresChanges","supabaseRealtimeStatuses","supabaseRpcCalls","supabaseSelectFields","supabaseSelects","supabaseStorageBuckets","supabaseTableWrites","typeReferences","valueReferences"],[["name","file","line","startLine",
    "endLine","startColumn","endColumn","docstring","signature","isExported","isConst","returns","typeReferences","valueReferences","calls","instantiates","jsxReferences"],["name","file","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isConst","returns",
    "typeReferences","valueReferences","calls","supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions",
    "supabaseRealtimeStatuses","instantiates","jsxReferences","configProperties","supabaseSelectFields"],["name","file","qualifiedName","line","startLine","endLine","startColumn","endColumn","docstring","signature","isExported","isConst","returns","typeReferences","valueReferences","calls",
    "supabaseSelects","supabaseIncrementalPredicates","supabaseStorageBuckets","supabaseFunctionInvokes","supabaseRpcCalls","supabaseTableWrites","supabaseRealtimeChannels","supabaseRealtimePostgresChanges","supabaseRealtimeLifecycleActions","supabaseRealtimeStatuses","instantiates","jsxReferences",
    "configProperties","supabaseSelectFields"]]],
["typescript.variables[].configProperties[]",["configObject","configPath","configProperty","docstring","endColumn","endLine","file","line","name","parentConfigPath","qualifiedName","signature","startColumn","startLine"],[["name","qualifiedName","file","line","startLine","endLine","startColumn",
    "endColumn","docstring","signature","configObject","configPath","parentConfigPath","configProperty"]]],
["typescript.variables[].supabaseSelectFields[]",["docstring","endColumn","endLine","field","file","line","name","qualifiedName","selectConfig","selectConfigProperty","signature","startColumn","startLine","table"],[["name","qualifiedName","file","line","startLine","endLine","startColumn",
    "endColumn","docstring","signature","selectConfig","selectConfigProperty","table","field"]]],
  ["typescript.variables[].supabaseTableWrites[]",["column","line","optionKeys","payloadKeys","table","writeOperation"],[["table","writeOperation","payloadKeys","optionKeys","line","column"]]],
];

const ARRAY_PATHS = [
  "typescript.classes", "typescript.classes[].decorators", "typescript.classes[].decorators[].argumentReferences",
  "typescript.classes[].extends", "typescript.classes[].implements", "typescript.classes[].instantiates",
  "typescript.classes[].jsxReferences", "typescript.classes[].methods", "typescript.classes[].methods[].calls",
  "typescript.classes[].methods[].decorators", "typescript.classes[].methods[].decorators[].argumentReferences", "typescript.classes[].methods[].hardRuleImplementationCalls",
  "typescript.classes[].methods[].instantiates", "typescript.classes[].methods[].jsxReferences", "typescript.classes[].methods[].localDeclarations.classes",
  "typescript.classes[].methods[].localDeclarations.enums", "typescript.classes[].methods[].localDeclarations.interfaces", "typescript.classes[].methods[].localDeclarations.types",
  "typescript.classes[].methods[].localDeclarations.types[].methods", "typescript.classes[].methods[].localDeclarations.types[].methods[].calls", "typescript.classes[].methods[].localDeclarations.types[].methods[].instantiates",
  "typescript.classes[].methods[].localDeclarations.types[].methods[].parameters", "typescript.classes[].methods[].localDeclarations.types[].methods[].typeParameterReferences", "typescript.classes[].methods[].localDeclarations.types[].methods[].typeParameters",
  "typescript.classes[].methods[].localDeclarations.types[].methods[].typeReferences", "typescript.classes[].methods[].localDeclarations.types[].properties", "typescript.classes[].methods[].localDeclarations.types[].typeParameterReferences",
  "typescript.classes[].methods[].localDeclarations.types[].typeParameters", "typescript.classes[].methods[].localDeclarations.types[].typeReferences", "typescript.classes[].methods[].parameters",
  "typescript.classes[].methods[].parameters[].typeReferences", "typescript.classes[].methods[].supabaseFunctionInvokes", "typescript.classes[].methods[].supabaseIncrementalPredicates",
  "typescript.classes[].methods[].supabaseRealtimeChannels", "typescript.classes[].methods[].supabaseRealtimeLifecycleActions", "typescript.classes[].methods[].supabaseRealtimePostgresChanges",
  "typescript.classes[].methods[].supabaseRealtimeStatuses", "typescript.classes[].methods[].supabaseRpcCalls", "typescript.classes[].methods[].supabaseRpcCalls[].argNames",
  "typescript.classes[].methods[].supabaseSelects", "typescript.classes[].methods[].supabaseSelects[].fields", "typescript.classes[].methods[].supabaseStorageBuckets",
  "typescript.classes[].methods[].supabaseTableWrites", "typescript.classes[].methods[].supabaseTableWrites[].optionKeys", "typescript.classes[].methods[].supabaseTableWrites[].payloadKeys",
  "typescript.classes[].methods[].typeParameterReferences", "typescript.classes[].methods[].typeParameters", "typescript.classes[].methods[].typeReferences",
  "typescript.classes[].methods[].valueReferences", "typescript.classes[].properties", "typescript.classes[].properties[].calls",
  "typescript.classes[].properties[].decorators", "typescript.classes[].properties[].decorators[].argumentReferences", "typescript.classes[].properties[].hardRuleImplementationCalls",
  "typescript.classes[].properties[].instantiates", "typescript.classes[].properties[].jsxReferences", "typescript.classes[].properties[].supabaseFunctionInvokes",
  "typescript.classes[].properties[].supabaseIncrementalPredicates", "typescript.classes[].properties[].supabaseRealtimeChannels", "typescript.classes[].properties[].supabaseRealtimeLifecycleActions",
  "typescript.classes[].properties[].supabaseRealtimePostgresChanges", "typescript.classes[].properties[].supabaseRealtimeStatuses", "typescript.classes[].properties[].supabaseRpcCalls",
  "typescript.classes[].properties[].supabaseSelects", "typescript.classes[].properties[].supabaseStorageBuckets", "typescript.classes[].properties[].supabaseTableWrites",
  "typescript.classes[].properties[].typeReferences", "typescript.classes[].properties[].valueReferences", "typescript.classes[].typeParameterReferences",
  "typescript.classes[].typeParameters", "typescript.classes[].typeReferences", "typescript.classes[].valueReferences",
  "typescript.enums", "typescript.enums[].members", "typescript.exports",
  "typescript.files", "typescript.functions", "typescript.functions[].calls",
  "typescript.functions[].configProperties", "typescript.functions[].decorators", "typescript.functions[].hardRuleImplementationCalls",
  "typescript.functions[].instantiates", "typescript.functions[].jsxReferences", "typescript.functions[].localDeclarations.classes",
  "typescript.functions[].localDeclarations.classes[].decorators", "typescript.functions[].localDeclarations.classes[].extends", "typescript.functions[].localDeclarations.classes[].implements",
  "typescript.functions[].localDeclarations.classes[].instantiates", "typescript.functions[].localDeclarations.classes[].jsxReferences", "typescript.functions[].localDeclarations.classes[].methods",
  "typescript.functions[].localDeclarations.classes[].methods[].calls", "typescript.functions[].localDeclarations.classes[].methods[].decorators", "typescript.functions[].localDeclarations.classes[].methods[].hardRuleImplementationCalls",
  "typescript.functions[].localDeclarations.classes[].methods[].instantiates", "typescript.functions[].localDeclarations.classes[].methods[].jsxReferences", "typescript.functions[].localDeclarations.classes[].methods[].localDeclarations.classes",
  "typescript.functions[].localDeclarations.classes[].methods[].localDeclarations.enums", "typescript.functions[].localDeclarations.classes[].methods[].localDeclarations.interfaces", "typescript.functions[].localDeclarations.classes[].methods[].localDeclarations.types",
  "typescript.functions[].localDeclarations.classes[].methods[].parameters", "typescript.functions[].localDeclarations.classes[].methods[].parameters[].typeReferences", "typescript.functions[].localDeclarations.classes[].methods[].supabaseFunctionInvokes",
  "typescript.functions[].localDeclarations.classes[].methods[].supabaseIncrementalPredicates", "typescript.functions[].localDeclarations.classes[].methods[].supabaseRealtimeChannels", "typescript.functions[].localDeclarations.classes[].methods[].supabaseRealtimeLifecycleActions",
  "typescript.functions[].localDeclarations.classes[].methods[].supabaseRealtimePostgresChanges", "typescript.functions[].localDeclarations.classes[].methods[].supabaseRealtimeStatuses", "typescript.functions[].localDeclarations.classes[].methods[].supabaseRpcCalls",
  "typescript.functions[].localDeclarations.classes[].methods[].supabaseSelects", "typescript.functions[].localDeclarations.classes[].methods[].supabaseStorageBuckets", "typescript.functions[].localDeclarations.classes[].methods[].supabaseTableWrites",
  "typescript.functions[].localDeclarations.classes[].methods[].typeParameterReferences", "typescript.functions[].localDeclarations.classes[].methods[].typeParameters", "typescript.functions[].localDeclarations.classes[].methods[].typeReferences",
  "typescript.functions[].localDeclarations.classes[].methods[].valueReferences", "typescript.functions[].localDeclarations.classes[].properties", "typescript.functions[].localDeclarations.classes[].properties[].calls",
  "typescript.functions[].localDeclarations.classes[].properties[].decorators", "typescript.functions[].localDeclarations.classes[].properties[].hardRuleImplementationCalls", "typescript.functions[].localDeclarations.classes[].properties[].instantiates",
  "typescript.functions[].localDeclarations.classes[].properties[].jsxReferences", "typescript.functions[].localDeclarations.classes[].properties[].supabaseFunctionInvokes", "typescript.functions[].localDeclarations.classes[].properties[].supabaseIncrementalPredicates",
  "typescript.functions[].localDeclarations.classes[].properties[].supabaseRealtimeChannels", "typescript.functions[].localDeclarations.classes[].properties[].supabaseRealtimeLifecycleActions", "typescript.functions[].localDeclarations.classes[].properties[].supabaseRealtimePostgresChanges",
  "typescript.functions[].localDeclarations.classes[].properties[].supabaseRealtimeStatuses", "typescript.functions[].localDeclarations.classes[].properties[].supabaseRpcCalls", "typescript.functions[].localDeclarations.classes[].properties[].supabaseSelects",
  "typescript.functions[].localDeclarations.classes[].properties[].supabaseStorageBuckets", "typescript.functions[].localDeclarations.classes[].properties[].supabaseTableWrites", "typescript.functions[].localDeclarations.classes[].properties[].typeReferences",
  "typescript.functions[].localDeclarations.classes[].properties[].valueReferences", "typescript.functions[].localDeclarations.classes[].typeParameterReferences", "typescript.functions[].localDeclarations.classes[].typeParameters",
  "typescript.functions[].localDeclarations.classes[].typeReferences", "typescript.functions[].localDeclarations.classes[].valueReferences", "typescript.functions[].localDeclarations.enums",
  "typescript.functions[].localDeclarations.interfaces", "typescript.functions[].localDeclarations.types", "typescript.functions[].localDeclarations.types[].methods",
  "typescript.functions[].localDeclarations.types[].properties", "typescript.functions[].localDeclarations.types[].properties[].calls", "typescript.functions[].localDeclarations.types[].properties[].instantiates",
  "typescript.functions[].localDeclarations.types[].properties[].typeReferences", "typescript.functions[].localDeclarations.types[].typeParameterReferences", "typescript.functions[].localDeclarations.types[].typeParameters",
  "typescript.functions[].localDeclarations.types[].typeReferences", "typescript.functions[].localTypeReferences", "typescript.functions[].nestedFunctions",
  "typescript.functions[].nestedFunctions[].calls", "typescript.functions[].nestedFunctions[].decorators", "typescript.functions[].nestedFunctions[].hardRuleImplementationCalls",
  "typescript.functions[].nestedFunctions[].instantiates", "typescript.functions[].nestedFunctions[].jsxReferences", "typescript.functions[].nestedFunctions[].localDeclarations.classes",
  "typescript.functions[].nestedFunctions[].localDeclarations.enums", "typescript.functions[].nestedFunctions[].localDeclarations.interfaces", "typescript.functions[].nestedFunctions[].localDeclarations.types",
  "typescript.functions[].nestedFunctions[].localTypeReferences", "typescript.functions[].nestedFunctions[].nestedFunctions", "typescript.functions[].nestedFunctions[].nestedFunctions[].calls",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].decorators", "typescript.functions[].nestedFunctions[].nestedFunctions[].hardRuleImplementationCalls", "typescript.functions[].nestedFunctions[].nestedFunctions[].instantiates",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].jsxReferences", "typescript.functions[].nestedFunctions[].nestedFunctions[].localDeclarations.classes", "typescript.functions[].nestedFunctions[].nestedFunctions[].localDeclarations.enums",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].localDeclarations.interfaces", "typescript.functions[].nestedFunctions[].nestedFunctions[].localDeclarations.types", "typescript.functions[].nestedFunctions[].nestedFunctions[].localTypeReferences",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].calls", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].decorators",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].hardRuleImplementationCalls", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].instantiates", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].jsxReferences",
"typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].localDeclarations.classes", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].localDeclarations.enums",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].localDeclarations.interfaces",
"typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].localDeclarations.types", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].localTypeReferences", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].nestedFunctions",

"typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].typeReferences",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseFunctionInvokes",
"typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseIncrementalPredicates", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseRealtimeChannels",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseRealtimeLifecycleActions",
"typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseRealtimePostgresChanges", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseRealtimeStatuses",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseRpcCalls",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseSelects", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseStorageBuckets", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].supabaseTableWrites",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].typeParameterReferences", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].typeParameters", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].typeReferences",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].valueReferences", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].typeReferences",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseFunctionInvokes", "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseIncrementalPredicates", "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseRealtimeChannels",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseRealtimeLifecycleActions", "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseRealtimePostgresChanges", "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseRealtimeStatuses",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseRpcCalls", "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseSelects", "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseStorageBuckets",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].supabaseTableWrites", "typescript.functions[].nestedFunctions[].nestedFunctions[].typeParameterReferences", "typescript.functions[].nestedFunctions[].nestedFunctions[].typeParameters",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].typeReferences", "typescript.functions[].nestedFunctions[].nestedFunctions[].valueReferences", "typescript.functions[].nestedFunctions[].parameters",
  "typescript.functions[].nestedFunctions[].parameters[].typeReferences", "typescript.functions[].nestedFunctions[].supabaseFunctionInvokes", "typescript.functions[].nestedFunctions[].supabaseIncrementalPredicates",
  "typescript.functions[].nestedFunctions[].supabaseRealtimeChannels", "typescript.functions[].nestedFunctions[].supabaseRealtimeLifecycleActions", "typescript.functions[].nestedFunctions[].supabaseRealtimePostgresChanges",
  "typescript.functions[].nestedFunctions[].supabaseRealtimeStatuses", "typescript.functions[].nestedFunctions[].supabaseRpcCalls", "typescript.functions[].nestedFunctions[].supabaseSelects",
  "typescript.functions[].nestedFunctions[].supabaseStorageBuckets", "typescript.functions[].nestedFunctions[].supabaseTableWrites", "typescript.functions[].nestedFunctions[].typeParameterReferences",
  "typescript.functions[].nestedFunctions[].typeParameters", "typescript.functions[].nestedFunctions[].typeReferences", "typescript.functions[].nestedFunctions[].valueReferences",
  "typescript.functions[].overloadSignatures", "typescript.functions[].parameters", "typescript.functions[].parameters[].typeReferences",
  "typescript.functions[].supabaseFunctionInvokes", "typescript.functions[].supabaseIncrementalPredicates", "typescript.functions[].supabaseRealtimeChannels",
  "typescript.functions[].supabaseRealtimeLifecycleActions", "typescript.functions[].supabaseRealtimePostgresChanges", "typescript.functions[].supabaseRealtimeStatuses",
  "typescript.functions[].supabaseRpcCalls", "typescript.functions[].supabaseRpcCalls[].argNames", "typescript.functions[].supabaseSelectFields",
  "typescript.functions[].supabaseSelects", "typescript.functions[].supabaseSelects[].fields", "typescript.functions[].supabaseStorageBuckets",
  "typescript.functions[].supabaseTableWrites", "typescript.functions[].supabaseTableWrites[].optionKeys", "typescript.functions[].supabaseTableWrites[].payloadKeys",
  "typescript.functions[].typeParameterReferences", "typescript.functions[].typeParameters", "typescript.functions[].typeReferences",
  "typescript.functions[].valueReferences", "typescript.imports", "typescript.interfaces",
  "typescript.interfaces[].extends", "typescript.interfaces[].methods", "typescript.interfaces[].methods[].calls",
  "typescript.interfaces[].methods[].instantiates", "typescript.interfaces[].methods[].parameters", "typescript.interfaces[].methods[].parameters[].typeReferences",
  "typescript.interfaces[].methods[].typeParameterReferences", "typescript.interfaces[].methods[].typeParameters", "typescript.interfaces[].methods[].typeReferences",
  "typescript.interfaces[].properties", "typescript.interfaces[].properties[].calls", "typescript.interfaces[].properties[].instantiates",
  "typescript.interfaces[].properties[].parameters", "typescript.interfaces[].properties[].parameters[].typeReferences", "typescript.interfaces[].properties[].typeReferences",
  "typescript.interfaces[].typeParameterReferences", "typescript.interfaces[].typeParameters", "typescript.interfaces[].typeReferences",
  "typescript.namespaces", "typescript.namespaces[].members", "typescript.parameters",
  "typescript.types", "typescript.types[].methods", "typescript.types[].methods[].calls",
  "typescript.types[].methods[].instantiates", "typescript.types[].methods[].parameters", "typescript.types[].methods[].parameters[].typeReferences",
  "typescript.types[].methods[].typeParameterReferences", "typescript.types[].methods[].typeParameters", "typescript.types[].methods[].typeReferences",
  "typescript.types[].properties", "typescript.types[].properties[].calls", "typescript.types[].properties[].instantiates",
  "typescript.types[].properties[].typeReferences", "typescript.types[].typeParameterReferences", "typescript.types[].typeParameters",
  "typescript.types[].typeReferences", "typescript.variables", "typescript.variables[].calls",
  "typescript.variables[].configProperties", "typescript.variables[].instantiates", "typescript.variables[].jsxReferences",
  "typescript.variables[].supabaseFunctionInvokes", "typescript.variables[].supabaseIncrementalPredicates", "typescript.variables[].supabaseRealtimeChannels",
  "typescript.variables[].supabaseRealtimeLifecycleActions", "typescript.variables[].supabaseRealtimePostgresChanges", "typescript.variables[].supabaseRealtimeStatuses",
  "typescript.variables[].supabaseRpcCalls", "typescript.variables[].supabaseSelectFields", "typescript.variables[].supabaseSelects",
  "typescript.variables[].supabaseStorageBuckets", "typescript.variables[].supabaseTableWrites", "typescript.variables[].supabaseTableWrites[].optionKeys",
  "typescript.variables[].supabaseTableWrites[].payloadKeys", "typescript.variables[].typeReferences", "typescript.variables[].valueReferences",
];

const SCALAR_TYPE_GROUPS = [
  [["boolean"], [
    "typescript.classes[].isAbstract", "typescript.classes[].isDefaultExport", "typescript.classes[].isExported",
    "typescript.classes[].methods[].hasBody", "typescript.classes[].methods[].isAbstract", "typescript.classes[].methods[].isAsync",
    "typescript.classes[].methods[].isOverride", "typescript.classes[].methods[].isStatic", "typescript.classes[].methods[].localDeclarations.types[].isDefaultExport",
    "typescript.classes[].methods[].localDeclarations.types[].isExported", "typescript.classes[].properties[].isAbstract", "typescript.classes[].properties[].isOverride",
    "typescript.classes[].properties[].isStatic", "typescript.enums[].isDefaultExport", "typescript.enums[].isExported",
    "typescript.functions[].hasBody", "typescript.functions[].isAsync", "typescript.functions[].isConst",
    "typescript.functions[].isDefaultExport", "typescript.functions[].isExported", "typescript.functions[].localDeclarations.classes[].isAbstract",
    "typescript.functions[].localDeclarations.classes[].isDefaultExport", "typescript.functions[].localDeclarations.classes[].isExported", "typescript.functions[].localDeclarations.classes[].methods[].hasBody",
    "typescript.functions[].localDeclarations.classes[].methods[].isAbstract", "typescript.functions[].localDeclarations.classes[].methods[].isAsync", "typescript.functions[].localDeclarations.classes[].methods[].isOverride",
    "typescript.functions[].localDeclarations.classes[].methods[].isStatic", "typescript.functions[].localDeclarations.classes[].properties[].isAbstract", "typescript.functions[].localDeclarations.classes[].properties[].isOverride",
    "typescript.functions[].localDeclarations.classes[].properties[].isStatic", "typescript.functions[].localDeclarations.types[].isDefaultExport", "typescript.functions[].localDeclarations.types[].isExported",
    "typescript.functions[].nestedFunctions[].hasBody", "typescript.functions[].nestedFunctions[].isAsync", "typescript.functions[].nestedFunctions[].isExported",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].hasBody", "typescript.functions[].nestedFunctions[].nestedFunctions[].isAsync", "typescript.functions[].nestedFunctions[].nestedFunctions[].isExported",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].hasBody", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].isAsync", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].isExported",
    "typescript.interfaces[].isDefaultExport", "typescript.interfaces[].isExported", "typescript.namespaces[].isExported",
    "typescript.types[].isDefaultExport", "typescript.types[].isExported", "typescript.variables[].isConst",
    "typescript.variables[].isExported",
  ]],
  [["boolean","null"], [
    "typescript.exports[].isTypeOnly", "typescript.imports[].isTypeOnly",
  ]],
  [["null"], [
    "typescript.classes[].methods[].localDeclarations.types[].methods[].docstring", "typescript.classes[].methods[].localDeclarations.types[].methods[].returns", "typescript.classes[].methods[].parameters[].docstring",
    "typescript.functions[].localDeclarations.classes[].docstring", "typescript.functions[].localDeclarations.classes[].methods[].docstring", "typescript.functions[].localDeclarations.classes[].methods[].parameters[].docstring",
    "typescript.functions[].localDeclarations.classes[].methods[].parameters[].returns", "typescript.functions[].localDeclarations.classes[].methods[].returns", "typescript.functions[].localDeclarations.classes[].methods[].visibility",
    "typescript.functions[].localDeclarations.classes[].properties[].docstring", "typescript.functions[].localDeclarations.classes[].properties[].returns", "typescript.functions[].localDeclarations.classes[].properties[].visibility",
    "typescript.functions[].localDeclarations.types[].docstring", "typescript.functions[].localDeclarations.types[].properties[].docstring", "typescript.functions[].localDeclarations.types[].properties[].returns",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].docstring", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].returns", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].docstring",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].returns", "typescript.functions[].nestedFunctions[].parameters[].docstring", "typescript.interfaces[].methods[].parameters[].docstring",
    "typescript.interfaces[].properties[].parameters[].docstring", "typescript.interfaces[].properties[].parameters[].returns", "typescript.types[].methods[].docstring",
    "typescript.types[].methods[].parameters[].docstring",
  ]],
  [["null","string"], [
    "typescript.classes[].docstring", "typescript.classes[].methods[].docstring", "typescript.classes[].methods[].localDeclarations.types[].docstring",
    "typescript.classes[].methods[].parameters[].returns", "typescript.classes[].methods[].returns", "typescript.classes[].methods[].visibility",
    "typescript.classes[].properties[].docstring", "typescript.classes[].properties[].returns", "typescript.classes[].properties[].visibility",
    "typescript.enums[].members[].docstring", "typescript.functions[].nestedFunctions[].parameters[].returns", "typescript.functions[].parameters[].docstring",
    "typescript.functions[].parameters[].returns", "typescript.interfaces[].docstring", "typescript.interfaces[].methods[].docstring",
    "typescript.interfaces[].methods[].parameters[].returns", "typescript.interfaces[].methods[].returns", "typescript.interfaces[].properties[].docstring",
    "typescript.interfaces[].properties[].returns", "typescript.namespaces[].docstring", "typescript.types[].docstring",
    "typescript.types[].methods[].parameters[].returns", "typescript.types[].methods[].returns", "typescript.types[].properties[].docstring",
    "typescript.types[].properties[].returns", "typescript.variables[].configProperties[].docstring", "typescript.variables[].configProperties[].parentConfigPath",
    "typescript.variables[].docstring", "typescript.variables[].returns",
  ]],
  [["number"], [
    "typescript.classes[].decorators[].column", "typescript.classes[].decorators[].line", "typescript.classes[].endColumn",
    "typescript.classes[].endLine", "typescript.classes[].line", "typescript.classes[].methods[].decorators[].column",
    "typescript.classes[].methods[].decorators[].line", "typescript.classes[].methods[].endColumn", "typescript.classes[].methods[].endLine",
    "typescript.classes[].methods[].hardRuleImplementationCalls[].column", "typescript.classes[].methods[].hardRuleImplementationCalls[].line", "typescript.classes[].methods[].line",
    "typescript.classes[].methods[].localDeclarations.types[].endColumn", "typescript.classes[].methods[].localDeclarations.types[].endLine", "typescript.classes[].methods[].localDeclarations.types[].line",
    "typescript.classes[].methods[].localDeclarations.types[].methods[].endColumn", "typescript.classes[].methods[].localDeclarations.types[].methods[].endLine", "typescript.classes[].methods[].localDeclarations.types[].methods[].line",
    "typescript.classes[].methods[].localDeclarations.types[].methods[].startColumn", "typescript.classes[].methods[].localDeclarations.types[].methods[].startLine", "typescript.classes[].methods[].localDeclarations.types[].startColumn",
    "typescript.classes[].methods[].localDeclarations.types[].startLine", "typescript.classes[].methods[].parameters[].endColumn", "typescript.classes[].methods[].parameters[].endLine",
    "typescript.classes[].methods[].parameters[].line", "typescript.classes[].methods[].parameters[].startColumn", "typescript.classes[].methods[].parameters[].startLine",
    "typescript.classes[].methods[].startColumn", "typescript.classes[].methods[].startLine", "typescript.classes[].methods[].supabaseFunctionInvokes[].column",
    "typescript.classes[].methods[].supabaseFunctionInvokes[].line", "typescript.classes[].methods[].supabaseIncrementalPredicates[].columnNumber", "typescript.classes[].methods[].supabaseIncrementalPredicates[].line",
    "typescript.classes[].methods[].supabaseRealtimeChannels[].column", "typescript.classes[].methods[].supabaseRealtimeChannels[].line", "typescript.classes[].methods[].supabaseRealtimeLifecycleActions[].column",
    "typescript.classes[].methods[].supabaseRealtimeLifecycleActions[].line", "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].column", "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].line",
    "typescript.classes[].methods[].supabaseRealtimeStatuses[].column", "typescript.classes[].methods[].supabaseRealtimeStatuses[].line", "typescript.classes[].methods[].supabaseRpcCalls[].column",
    "typescript.classes[].methods[].supabaseRpcCalls[].line", "typescript.classes[].methods[].supabaseSelects[].column", "typescript.classes[].methods[].supabaseSelects[].line",
    "typescript.classes[].methods[].supabaseTableWrites[].column", "typescript.classes[].methods[].supabaseTableWrites[].line", "typescript.classes[].properties[].decorators[].column",
    "typescript.classes[].properties[].decorators[].line", "typescript.classes[].properties[].endColumn", "typescript.classes[].properties[].endLine",
    "typescript.classes[].properties[].hardRuleImplementationCalls[].column", "typescript.classes[].properties[].hardRuleImplementationCalls[].line", "typescript.classes[].properties[].line",
    "typescript.classes[].properties[].startColumn", "typescript.classes[].properties[].startLine", "typescript.classes[].startColumn",
    "typescript.classes[].startLine", "typescript.enums[].endColumn", "typescript.enums[].endLine",
    "typescript.enums[].line", "typescript.enums[].members[].endColumn", "typescript.enums[].members[].endLine",
    "typescript.enums[].members[].line", "typescript.enums[].members[].startColumn", "typescript.enums[].members[].startLine",
    "typescript.enums[].startColumn", "typescript.enums[].startLine", "typescript.exports[].line",
    "typescript.functions[].endColumn", "typescript.functions[].endLine", "typescript.functions[].hardRuleImplementationCalls[].column",
    "typescript.functions[].hardRuleImplementationCalls[].line", "typescript.functions[].line", "typescript.functions[].localDeclarations.classes[].endColumn",
    "typescript.functions[].localDeclarations.classes[].endLine", "typescript.functions[].localDeclarations.classes[].line", "typescript.functions[].localDeclarations.classes[].methods[].endColumn",
    "typescript.functions[].localDeclarations.classes[].methods[].endLine", "typescript.functions[].localDeclarations.classes[].methods[].line", "typescript.functions[].localDeclarations.classes[].methods[].parameters[].endColumn",
    "typescript.functions[].localDeclarations.classes[].methods[].parameters[].endLine", "typescript.functions[].localDeclarations.classes[].methods[].parameters[].line", "typescript.functions[].localDeclarations.classes[].methods[].parameters[].startColumn",
    "typescript.functions[].localDeclarations.classes[].methods[].parameters[].startLine", "typescript.functions[].localDeclarations.classes[].methods[].startColumn", "typescript.functions[].localDeclarations.classes[].methods[].startLine",
    "typescript.functions[].localDeclarations.classes[].properties[].endColumn", "typescript.functions[].localDeclarations.classes[].properties[].endLine", "typescript.functions[].localDeclarations.classes[].properties[].line",
    "typescript.functions[].localDeclarations.classes[].properties[].startColumn", "typescript.functions[].localDeclarations.classes[].properties[].startLine", "typescript.functions[].localDeclarations.classes[].startColumn",
    "typescript.functions[].localDeclarations.classes[].startLine", "typescript.functions[].localDeclarations.types[].endColumn", "typescript.functions[].localDeclarations.types[].endLine",
    "typescript.functions[].localDeclarations.types[].line", "typescript.functions[].localDeclarations.types[].properties[].endColumn", "typescript.functions[].localDeclarations.types[].properties[].endLine",
    "typescript.functions[].localDeclarations.types[].properties[].line", "typescript.functions[].localDeclarations.types[].properties[].startColumn", "typescript.functions[].localDeclarations.types[].properties[].startLine",
    "typescript.functions[].localDeclarations.types[].startColumn", "typescript.functions[].localDeclarations.types[].startLine", "typescript.functions[].nestedFunctions[].endColumn",
    "typescript.functions[].nestedFunctions[].endLine", "typescript.functions[].nestedFunctions[].hardRuleImplementationCalls[].column", "typescript.functions[].nestedFunctions[].hardRuleImplementationCalls[].line",
    "typescript.functions[].nestedFunctions[].line", "typescript.functions[].nestedFunctions[].nestedFunctions[].endColumn", "typescript.functions[].nestedFunctions[].nestedFunctions[].endLine",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].line", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].endColumn", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].endLine",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].line", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].endColumn", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].endLine",
"typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].line", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].startColumn",
      "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].startLine",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].startColumn", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].startLine", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].endColumn",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].endLine", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].line", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].startColumn",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].startLine", "typescript.functions[].nestedFunctions[].nestedFunctions[].startColumn", "typescript.functions[].nestedFunctions[].nestedFunctions[].startLine",
    "typescript.functions[].nestedFunctions[].parameters[].endColumn", "typescript.functions[].nestedFunctions[].parameters[].endLine", "typescript.functions[].nestedFunctions[].parameters[].line",
    "typescript.functions[].nestedFunctions[].parameters[].startColumn", "typescript.functions[].nestedFunctions[].parameters[].startLine", "typescript.functions[].nestedFunctions[].startColumn",
    "typescript.functions[].nestedFunctions[].startLine", "typescript.functions[].overloads", "typescript.functions[].parameters[].endColumn",
    "typescript.functions[].parameters[].endLine", "typescript.functions[].parameters[].line", "typescript.functions[].parameters[].startColumn",
    "typescript.functions[].parameters[].startLine", "typescript.functions[].startColumn", "typescript.functions[].startLine",
    "typescript.functions[].supabaseRealtimeChannels[].column", "typescript.functions[].supabaseRealtimeChannels[].line", "typescript.functions[].supabaseRealtimeLifecycleActions[].column",
    "typescript.functions[].supabaseRealtimeLifecycleActions[].line", "typescript.functions[].supabaseRpcCalls[].column", "typescript.functions[].supabaseRpcCalls[].line",
    "typescript.functions[].supabaseSelects[].column", "typescript.functions[].supabaseSelects[].line", "typescript.functions[].supabaseStorageBuckets[].column",
    "typescript.functions[].supabaseStorageBuckets[].line", "typescript.functions[].supabaseTableWrites[].column", "typescript.functions[].supabaseTableWrites[].line",
    "typescript.imports[].line", "typescript.interfaces[].endColumn", "typescript.interfaces[].endLine",
    "typescript.interfaces[].line", "typescript.interfaces[].methods[].endColumn", "typescript.interfaces[].methods[].endLine",
    "typescript.interfaces[].methods[].line", "typescript.interfaces[].methods[].parameters[].endColumn", "typescript.interfaces[].methods[].parameters[].endLine",
    "typescript.interfaces[].methods[].parameters[].line", "typescript.interfaces[].methods[].parameters[].startColumn", "typescript.interfaces[].methods[].parameters[].startLine",
    "typescript.interfaces[].methods[].startColumn", "typescript.interfaces[].methods[].startLine", "typescript.interfaces[].properties[].endColumn",
    "typescript.interfaces[].properties[].endLine", "typescript.interfaces[].properties[].line", "typescript.interfaces[].properties[].parameters[].endColumn",
    "typescript.interfaces[].properties[].parameters[].endLine", "typescript.interfaces[].properties[].parameters[].line", "typescript.interfaces[].properties[].parameters[].startColumn",
    "typescript.interfaces[].properties[].parameters[].startLine", "typescript.interfaces[].properties[].startColumn", "typescript.interfaces[].properties[].startLine",
    "typescript.interfaces[].startColumn", "typescript.interfaces[].startLine", "typescript.namespaces[].endColumn",
    "typescript.namespaces[].endLine", "typescript.namespaces[].line", "typescript.namespaces[].members[].endColumn",
    "typescript.namespaces[].members[].endLine", "typescript.namespaces[].members[].line", "typescript.namespaces[].members[].startColumn",
    "typescript.namespaces[].members[].startLine", "typescript.namespaces[].startColumn", "typescript.namespaces[].startLine",
    "typescript.types[].endColumn", "typescript.types[].endLine", "typescript.types[].line",
    "typescript.types[].methods[].endColumn", "typescript.types[].methods[].endLine", "typescript.types[].methods[].line",
    "typescript.types[].methods[].parameters[].endColumn", "typescript.types[].methods[].parameters[].endLine", "typescript.types[].methods[].parameters[].line",
    "typescript.types[].methods[].parameters[].startColumn", "typescript.types[].methods[].parameters[].startLine", "typescript.types[].methods[].startColumn",
    "typescript.types[].methods[].startLine", "typescript.types[].properties[].endColumn", "typescript.types[].properties[].endLine",
    "typescript.types[].properties[].line", "typescript.types[].properties[].startColumn", "typescript.types[].properties[].startLine",
    "typescript.types[].startColumn", "typescript.types[].startLine", "typescript.variables[].configProperties[].endColumn",
    "typescript.variables[].configProperties[].endLine", "typescript.variables[].configProperties[].line", "typescript.variables[].configProperties[].startColumn",
    "typescript.variables[].configProperties[].startLine", "typescript.variables[].endColumn", "typescript.variables[].endLine",
    "typescript.variables[].line", "typescript.variables[].startColumn", "typescript.variables[].startLine",
    "typescript.variables[].supabaseSelectFields[].endColumn", "typescript.variables[].supabaseSelectFields[].endLine", "typescript.variables[].supabaseSelectFields[].line",
    "typescript.variables[].supabaseSelectFields[].startColumn", "typescript.variables[].supabaseSelectFields[].startLine", "typescript.variables[].supabaseTableWrites[].column",
    "typescript.variables[].supabaseTableWrites[].line",
  ]],
  [["string"], [
    "typescript.classes[].className", "typescript.classes[].decorators[].argumentReferences[]", "typescript.classes[].decorators[].name",
    "typescript.classes[].extends[]", "typescript.classes[].file", "typescript.classes[].implements[]",
    "typescript.classes[].instantiates[]", "typescript.classes[].localDeclarationOwnerKind", "typescript.classes[].localDeclarationOwnerQualifiedName",
    "typescript.classes[].methods[].calls[]", "typescript.classes[].methods[].decorators[].argumentReferences[]", "typescript.classes[].methods[].decorators[].name",
    "typescript.classes[].methods[].hardRuleImplementationCalls[].call", "typescript.classes[].methods[].hardRuleImplementationCalls[].keyword", "typescript.classes[].methods[].instantiates[]",
    "typescript.classes[].methods[].localDeclarations.types[].file", "typescript.classes[].methods[].localDeclarations.types[].localDeclarationOwnerKind", "typescript.classes[].methods[].localDeclarations.types[].localDeclarationOwnerQualifiedName",
    "typescript.classes[].methods[].localDeclarations.types[].methods[].name", "typescript.classes[].methods[].localDeclarations.types[].methods[].signature", "typescript.classes[].methods[].localDeclarations.types[].name",
    "typescript.classes[].methods[].localDeclarations.types[].qualifiedName", "typescript.classes[].methods[].localDeclarations.types[].signature", "typescript.classes[].methods[].name",
    "typescript.classes[].methods[].parameters[].name", "typescript.classes[].methods[].parameters[].signature", "typescript.classes[].methods[].parameters[].typeReferences[]",
    "typescript.classes[].methods[].signature", "typescript.classes[].methods[].supabaseFunctionInvokes[].invokeName", "typescript.classes[].methods[].supabaseFunctionInvokes[].path",
    "typescript.classes[].methods[].supabaseIncrementalPredicates[].column", "typescript.classes[].methods[].supabaseIncrementalPredicates[].cursor", "typescript.classes[].methods[].supabaseIncrementalPredicates[].cursorKeyword",
    "typescript.classes[].methods[].supabaseIncrementalPredicates[].name", "typescript.classes[].methods[].supabaseIncrementalPredicates[].operator", "typescript.classes[].methods[].supabaseIncrementalPredicates[].table",
    "typescript.classes[].methods[].supabaseRealtimeChannels[].channelName", "typescript.classes[].methods[].supabaseRealtimeLifecycleActions[].action", "typescript.classes[].methods[].supabaseRealtimeLifecycleActions[].channelVariable",
    "typescript.classes[].methods[].supabaseRealtimeLifecycleActions[].relation", "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].channelName", "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].event",
    "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].filter", "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].schema", "typescript.classes[].methods[].supabaseRealtimePostgresChanges[].table",
    "typescript.classes[].methods[].supabaseRealtimeStatuses[].action", "typescript.classes[].methods[].supabaseRealtimeStatuses[].status", "typescript.classes[].methods[].supabaseRpcCalls[].argNames[]",
    "typescript.classes[].methods[].supabaseRpcCalls[].functionName", "typescript.classes[].methods[].supabaseSelects[].fields[]", "typescript.classes[].methods[].supabaseSelects[].selectConfig",
    "typescript.classes[].methods[].supabaseSelects[].table", "typescript.classes[].methods[].supabaseTableWrites[].optionKeys[]", "typescript.classes[].methods[].supabaseTableWrites[].table",
    "typescript.classes[].methods[].supabaseTableWrites[].writeOperation", "typescript.classes[].methods[].typeParameterReferences[].relation", "typescript.classes[].methods[].typeParameterReferences[].target",
    "typescript.classes[].methods[].typeParameterReferences[].typeParameter", "typescript.classes[].methods[].typeParameters[]", "typescript.classes[].methods[].typeReferences[]",
    "typescript.classes[].methods[].valueReferences[]", "typescript.classes[].properties[].calls[]", "typescript.classes[].properties[].decorators[].argumentReferences[]",
    "typescript.classes[].properties[].decorators[].name", "typescript.classes[].properties[].hardRuleImplementationCalls[].call", "typescript.classes[].properties[].hardRuleImplementationCalls[].keyword",
    "typescript.classes[].properties[].instantiates[]", "typescript.classes[].properties[].name", "typescript.classes[].properties[].signature",
    "typescript.classes[].properties[].typeReferences[]", "typescript.classes[].properties[].valueReferences[]", "typescript.classes[].qualifiedName",
    "typescript.classes[].signature", "typescript.classes[].typeParameterReferences[].relation", "typescript.classes[].typeParameterReferences[].target",
    "typescript.classes[].typeParameterReferences[].typeParameter", "typescript.classes[].typeParameters[]", "typescript.classes[].typeReferences[]",
    "typescript.classes[].valueReferences[]", "typescript.enums[].docstring", "typescript.enums[].file",
    "typescript.enums[].members[].name", "typescript.enums[].members[].signature", "typescript.enums[].name",
    "typescript.enums[].signature", "typescript.exports[].exportName", "typescript.exports[].file",
    "typescript.exports[].name", "typescript.exports[].relation", "typescript.exports[].target",
    "typescript.exports[].targetName", "typescript.files[].file", "typescript.files[].language",
    "typescript.functions[].calls[]", "typescript.functions[].docstring", "typescript.functions[].file",
    "typescript.functions[].hardRuleImplementationCalls[].call", "typescript.functions[].hardRuleImplementationCalls[].keyword", "typescript.functions[].instantiates[]",
    "typescript.functions[].localDeclarations.classes[].className", "typescript.functions[].localDeclarations.classes[].file", "typescript.functions[].localDeclarations.classes[].localDeclarationOwnerKind",
    "typescript.functions[].localDeclarations.classes[].localDeclarationOwnerQualifiedName", "typescript.functions[].localDeclarations.classes[].methods[].calls[]", "typescript.functions[].localDeclarations.classes[].methods[].name",
    "typescript.functions[].localDeclarations.classes[].methods[].parameters[].name", "typescript.functions[].localDeclarations.classes[].methods[].parameters[].signature", "typescript.functions[].localDeclarations.classes[].methods[].signature",
    "typescript.functions[].localDeclarations.classes[].methods[].typeReferences[]", "typescript.functions[].localDeclarations.classes[].methods[].valueReferences[]", "typescript.functions[].localDeclarations.classes[].properties[].calls[]",
    "typescript.functions[].localDeclarations.classes[].properties[].name", "typescript.functions[].localDeclarations.classes[].properties[].signature", "typescript.functions[].localDeclarations.classes[].properties[].typeReferences[]",
    "typescript.functions[].localDeclarations.classes[].properties[].valueReferences[]", "typescript.functions[].localDeclarations.classes[].qualifiedName", "typescript.functions[].localDeclarations.classes[].signature",
    "typescript.functions[].localDeclarations.classes[].valueReferences[]", "typescript.functions[].localDeclarations.types[].file", "typescript.functions[].localDeclarations.types[].localDeclarationOwnerKind",
    "typescript.functions[].localDeclarations.types[].localDeclarationOwnerQualifiedName", "typescript.functions[].localDeclarations.types[].name", "typescript.functions[].localDeclarations.types[].properties[].name",
    "typescript.functions[].localDeclarations.types[].properties[].signature", "typescript.functions[].localDeclarations.types[].qualifiedName", "typescript.functions[].localDeclarations.types[].signature",
    "typescript.functions[].localDeclarations.types[].typeReferences[]", "typescript.functions[].localTypeReferences[]", "typescript.functions[].name",
    "typescript.functions[].nestedFunctions[].calls[]", "typescript.functions[].nestedFunctions[].docstring", "typescript.functions[].nestedFunctions[].file",
  "typescript.functions[].nestedFunctions[].hardRuleImplementationCalls[].call", "typescript.functions[].nestedFunctions[].hardRuleImplementationCalls[].keyword", "typescript.functions[].nestedFunctions[].instantiates[]",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].instantiates[]",
  "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].instantiates[]",
    "typescript.functions[].nestedFunctions[].localTypeReferences[]", "typescript.functions[].nestedFunctions[].name", "typescript.functions[].nestedFunctions[].nestedFunctions[].calls[]",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].file", "typescript.functions[].nestedFunctions[].nestedFunctions[].name", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].calls[]",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].file", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].name", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].nestedOwnerQualifiedName",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].name", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].parameters[].signature", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].qualifiedName",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].signature", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].typeReferences[]", "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedFunctions[].valueReferences[]",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].nestedOwnerQualifiedName", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].name", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].signature", "typescript.functions[].nestedFunctions[].nestedFunctions[].parameters[].typeReferences[]",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].qualifiedName", "typescript.functions[].nestedFunctions[].nestedFunctions[].signature", "typescript.functions[].nestedFunctions[].nestedFunctions[].typeReferences[]",
    "typescript.functions[].nestedFunctions[].nestedFunctions[].valueReferences[]", "typescript.functions[].nestedFunctions[].nestedOwnerQualifiedName", "typescript.functions[].nestedFunctions[].parameters[].name",
    "typescript.functions[].nestedFunctions[].parameters[].signature", "typescript.functions[].nestedFunctions[].parameters[].typeReferences[]", "typescript.functions[].nestedFunctions[].qualifiedName",
    "typescript.functions[].nestedFunctions[].returns", "typescript.functions[].nestedFunctions[].signature", "typescript.functions[].nestedFunctions[].typeParameters[]",
    "typescript.functions[].nestedFunctions[].typeReferences[]", "typescript.functions[].nestedFunctions[].valueReferences[]", "typescript.functions[].nestedOwnerQualifiedName",
    "typescript.functions[].objectOwnerKind", "typescript.functions[].objectOwnerName", "typescript.functions[].objectOwnerQualifiedName",
    "typescript.functions[].overloadSignatures[]", "typescript.functions[].parameters[].name", "typescript.functions[].parameters[].signature",
    "typescript.functions[].parameters[].typeReferences[]", "typescript.functions[].qualifiedName", "typescript.functions[].returns",
    "typescript.functions[].signature", "typescript.functions[].supabaseRealtimeChannels[].channelName", "typescript.functions[].supabaseRealtimeLifecycleActions[].action",
    "typescript.functions[].supabaseRealtimeLifecycleActions[].channelVariable", "typescript.functions[].supabaseRealtimeLifecycleActions[].relation", "typescript.functions[].supabaseRpcCalls[].argNames[]",
    "typescript.functions[].supabaseRpcCalls[].functionName", "typescript.functions[].supabaseSelects[].fields[]", "typescript.functions[].supabaseSelects[].table",
    "typescript.functions[].supabaseStorageBuckets[].bucket", "typescript.functions[].supabaseTableWrites[].optionKeys[]", "typescript.functions[].supabaseTableWrites[].payloadKeys[]",
    "typescript.functions[].supabaseTableWrites[].table", "typescript.functions[].supabaseTableWrites[].writeOperation", "typescript.functions[].typeParameterReferences[].relation",
    "typescript.functions[].typeParameterReferences[].target", "typescript.functions[].typeParameterReferences[].typeParameter", "typescript.functions[].typeParameters[]",
    "typescript.functions[].typeReferences[]", "typescript.functions[].valueReferences[]", "typescript.imports[].file",
    "typescript.imports[].importedName", "typescript.imports[].name", "typescript.imports[].relation",
    "typescript.imports[].target", "typescript.interfaces[].extends[]", "typescript.interfaces[].file",
    "typescript.interfaces[].methods[].name", "typescript.interfaces[].methods[].parameters[].name", "typescript.interfaces[].methods[].parameters[].signature",
    "typescript.interfaces[].methods[].parameters[].typeReferences[]", "typescript.interfaces[].methods[].signature", "typescript.interfaces[].methods[].typeParameters[]",
    "typescript.interfaces[].methods[].typeReferences[]", "typescript.interfaces[].name", "typescript.interfaces[].properties[].name",
    "typescript.interfaces[].properties[].parameters[].name", "typescript.interfaces[].properties[].parameters[].signature", "typescript.interfaces[].properties[].signature",
    "typescript.interfaces[].properties[].typeReferences[]", "typescript.interfaces[].qualifiedName", "typescript.interfaces[].signature",
    "typescript.interfaces[].typeParameterReferences[].relation", "typescript.interfaces[].typeParameterReferences[].target", "typescript.interfaces[].typeParameterReferences[].typeParameter",
    "typescript.interfaces[].typeParameters[]", "typescript.interfaces[].typeReferences[]", "typescript.namespaces[].file",
    "typescript.namespaces[].members[].kind", "typescript.namespaces[].members[].name", "typescript.namespaces[].name",
    "typescript.namespaces[].signature", "typescript.types[].file", "typescript.types[].localDeclarationOwnerKind",
    "typescript.types[].localDeclarationOwnerQualifiedName", "typescript.types[].methods[].name", "typescript.types[].methods[].parameters[].name",
    "typescript.types[].methods[].parameters[].signature", "typescript.types[].methods[].parameters[].typeReferences[]", "typescript.types[].methods[].signature",
    "typescript.types[].methods[].typeParameters[]", "typescript.types[].methods[].typeReferences[]", "typescript.types[].name",
    "typescript.types[].properties[].name", "typescript.types[].properties[].signature", "typescript.types[].properties[].typeReferences[]",
    "typescript.types[].qualifiedName", "typescript.types[].signature", "typescript.types[].typeParameterReferences[].relation",
    "typescript.types[].typeParameterReferences[].target", "typescript.types[].typeParameterReferences[].typeParameter", "typescript.types[].typeParameters[]",
    "typescript.types[].typeReferences[]", "typescript.variables[].calls[]", "typescript.variables[].configProperties[].configObject",
    "typescript.variables[].configProperties[].configPath", "typescript.variables[].configProperties[].configProperty", "typescript.variables[].configProperties[].file",
    "typescript.variables[].configProperties[].name", "typescript.variables[].configProperties[].qualifiedName", "typescript.variables[].configProperties[].signature",
    "typescript.variables[].file", "typescript.variables[].instantiates[]", "typescript.variables[].name",
    "typescript.variables[].qualifiedName", "typescript.variables[].signature", "typescript.variables[].supabaseSelectFields[].docstring",
    "typescript.variables[].supabaseSelectFields[].field", "typescript.variables[].supabaseSelectFields[].file", "typescript.variables[].supabaseSelectFields[].name",
    "typescript.variables[].supabaseSelectFields[].qualifiedName", "typescript.variables[].supabaseSelectFields[].selectConfig", "typescript.variables[].supabaseSelectFields[].selectConfigProperty",
    "typescript.variables[].supabaseSelectFields[].signature", "typescript.variables[].supabaseSelectFields[].table", "typescript.variables[].supabaseTableWrites[].table",
    "typescript.variables[].supabaseTableWrites[].writeOperation", "typescript.variables[].typeReferences[]", "typescript.variables[].valueReferences[]",
  ]],
];

const sameList = (left, right) => (
  left.length === right.length && left.every((value, index) => value === right[index])
);
const belongsTo = (schemaPath, prefix) => (
  schemaPath === prefix || schemaPath.startsWith(`${prefix}.`)
);
const words = value => value.trim().split(/\s+/);

function addObjectOrder(schemaPath, order) {
  let rule = OBJECT_RULES.find(([candidate]) => candidate === schemaPath);
  if (!rule) {
    rule = [schemaPath, [], []];
    OBJECT_RULES.push(rule);
  }
  rule[1] = [...new Set([...rule[1], ...order])].sort();
  if (!rule[2].some(candidate => sameList(candidate, order))) rule[2].push([...order]);
}

function addScalarTypes(schemaPath, additions) {
  const existing = SCALAR_TYPE_GROUPS.flatMap(([types, paths]) => (
    paths.includes(schemaPath) ? types : []
  ));
  const targetTypes = [...new Set([...existing, ...additions])].sort();
  for (const [, paths] of SCALAR_TYPE_GROUPS) {
    const index = paths.indexOf(schemaPath);
    if (index !== -1) paths.splice(index, 1);
  }
  let group = SCALAR_TYPE_GROUPS.find(([types]) => sameList(types, targetTypes));
  if (!group) {
    group = [targetTypes, []];
    SCALAR_TYPE_GROUPS.push(group);
  }
  group[1].push(schemaPath);
}

function inheritDescriptorBranch(basePrefix, targetPrefix, options = {}) {
  const baseRules = OBJECT_RULES.filter(([schemaPath]) => belongsTo(schemaPath, basePrefix));
  for (const [schemaPath, , orders] of baseRules) {
    const suffix = schemaPath.slice(basePrefix.length);
    if (suffix === '' && options.copyRoot !== true) continue;
    for (const order of orders) addObjectOrder(`${targetPrefix}${suffix}`, order);
  }
  for (const order of options.rootOrders || []) addObjectOrder(targetPrefix, order);
  for (const schemaPath of [...ARRAY_PATHS]) {
    if (!belongsTo(schemaPath, basePrefix)) continue;
    const targetPath = `${targetPrefix}${schemaPath.slice(basePrefix.length)}`;
    if (!ARRAY_PATHS.includes(targetPath)) ARRAY_PATHS.push(targetPath);
  }
  const scalarEntries = SCALAR_TYPE_GROUPS.flatMap(([types, paths]) => (
    paths.filter(schemaPath => belongsTo(schemaPath, basePrefix)).map(schemaPath => [schemaPath, types])
  ));
  for (const [schemaPath, types] of scalarEntries) {
    addScalarTypes(`${targetPrefix}${schemaPath.slice(basePrefix.length)}`, types);
  }
  for (const [suffix, types] of options.rootScalars || []) addScalarTypes(`${targetPrefix}${suffix}`, types);
}

inheritDescriptorBranch('typescript.classes[]', 'typescript.functions[].localDeclarations.classes[]');
inheritDescriptorBranch('typescript.functions[].localDeclarations.classes[]',
  'typescript.classes[].methods[].localDeclarations.classes[]', { copyRoot: true });
inheritDescriptorBranch('typescript.interfaces[]', 'typescript.functions[].localDeclarations.interfaces[]', {
  rootOrders: [words(`name qualifiedName file line startLine endLine startColumn endColumn docstring signature
    isExported isDefaultExport typeParameters typeParameterReferences methods properties extends typeReferences
    localDeclarationOwnerQualifiedName localDeclarationOwnerKind`)],
  rootScalars: [['.localDeclarationOwnerQualifiedName', ['string']], ['.localDeclarationOwnerKind', ['string']]],
});
inheritDescriptorBranch('typescript.enums[]', 'typescript.functions[].localDeclarations.enums[]', {
  rootOrders: [words(`name qualifiedName file line startLine endLine startColumn endColumn docstring signature
    isExported isDefaultExport members localDeclarationOwnerQualifiedName localDeclarationOwnerKind`)],
  rootScalars: [['.qualifiedName', ['string']], ['.localDeclarationOwnerQualifiedName', ['string']],
    ['.localDeclarationOwnerKind', ['string']]],
});
inheritDescriptorBranch('typescript.types[]', 'typescript.functions[].localDeclarations.types[]');
inheritDescriptorBranch('typescript.interfaces[].methods[].parameters[]',
  'typescript.types[].properties[].parameters[]', { copyRoot: true });

const GENERATOR_COMPATIBILITY_PROFILE = {
  objectOrders: [
    ['typescript.classes[]', words(`className file line startLine endLine startColumn endColumn docstring signature
      isExported isDefaultExport isAbstract decorators typeParameters typeParameterReferences methods properties
      extends implements instantiates valueReferences jsxReferences typeReferences`)],
    ['typescript.classes[].methods[].supabaseStorageBuckets[]', words('bucket line column')],
    ['typescript.classes[].methods[].supabaseRealtimeLifecycleActions[]', words('relation action channelName line column')],
    ['typescript.classes[].methods[].supabaseRealtimeLifecycleActions[]', words('relation action channelName channelVariable line column')],
    ['typescript.classes[].methods[].supabaseRealtimeLifecycleActions[]', words('relation action line column')],
    ['typescript.functions[]', words(`name file qualifiedName line startLine endLine startColumn endColumn signature
      isExported isAsync hasBody decorators typeParameters typeParameterReferences parameters valueReferences calls
      hardRuleImplementationCalls supabaseSelects supabaseIncrementalPredicates supabaseStorageBuckets
      supabaseFunctionInvokes supabaseRpcCalls supabaseTableWrites supabaseRealtimeChannels
      supabaseRealtimePostgresChanges supabaseRealtimeLifecycleActions supabaseRealtimeStatuses instantiates
      jsxReferences nestedFunctions localDeclarations localTypeReferences typeReferences overloadSignatures`)],
    ['typescript.functions[]', words(`name file qualifiedName line startLine endLine startColumn endColumn signature
      isExported isAsync hasBody returns decorators typeParameters typeParameterReferences parameters valueReferences
      calls hardRuleImplementationCalls supabaseSelects supabaseIncrementalPredicates supabaseStorageBuckets
      supabaseFunctionInvokes supabaseRpcCalls supabaseTableWrites supabaseRealtimeChannels
      supabaseRealtimePostgresChanges supabaseRealtimeLifecycleActions supabaseRealtimeStatuses instantiates
      jsxReferences nestedFunctions localDeclarations localTypeReferences typeReferences isDefaultExport overloads
      overloadSignatures`)],
    ['typescript.functions[]', words(`name qualifiedName file line startLine endLine startColumn endColumn signature
      isExported isAsync hasBody returns typeParameters typeParameterReferences parameters typeReferences
      valueReferences calls hardRuleImplementationCalls instantiates jsxReferences objectOwnerName
      objectOwnerQualifiedName objectOwnerKind overloadSignatures`)],
    ['typescript.functions[].supabaseRealtimeLifecycleActions[]', words('relation action channelName line column')],
    ['typescript.functions[].supabaseRealtimeLifecycleActions[]', words('relation action channelVariable line column')],
    ['typescript.functions[].supabaseRealtimeLifecycleActions[]', words('relation action line column')],
    ['typescript.interfaces[]', words(`name qualifiedName file line startLine endLine startColumn endColumn docstring
      signature isExported isDefaultExport typeParameters typeParameterReferences methods properties extends
      typeReferences localDeclarationOwnerQualifiedName localDeclarationOwnerKind`)],
    ['typescript.types[].methods[]', words(`name line startLine endLine startColumn endColumn signature
      typeParameterReferences typeReferences parameters calls instantiates`)],
    ['typescript.types[].properties[]', words(`name line startLine endLine startColumn endColumn docstring signature
      returns typeReferences parameters calls instantiates`)],
    ['typescript.enums[]', words(`name qualifiedName file line startLine endLine startColumn endColumn docstring
      signature isExported isDefaultExport members localDeclarationOwnerQualifiedName localDeclarationOwnerKind`)],
  ],
  arrayPaths: ['typescript.types[].properties[].parameters'],
  scalarTypes: [
    [['null'], words(`typescript.enums[].docstring typescript.functions[].localDeclarations.enums[].docstring
      typescript.variables[].supabaseSelectFields[].docstring`)],
    [['number'], words(`typescript.classes[].methods[].supabaseStorageBuckets[].line
      typescript.classes[].methods[].supabaseStorageBuckets[].column`)],
    [['string'], words(`typescript.classes[].methods[].supabaseStorageBuckets[].bucket
      typescript.classes[].methods[].supabaseRealtimeLifecycleActions[].channelName
      typescript.classes[].methods[].supabaseTableWrites[].payloadKeys[] typescript.functions[].jsxReferences[]
      typescript.interfaces[].localDeclarationOwnerQualifiedName typescript.interfaces[].localDeclarationOwnerKind
      typescript.enums[].qualifiedName typescript.enums[].localDeclarationOwnerQualifiedName
      typescript.enums[].localDeclarationOwnerKind`)],
  ],
};

for (const [schemaPath, order] of GENERATOR_COMPATIBILITY_PROFILE.objectOrders) addObjectOrder(schemaPath, order);
for (const schemaPath of GENERATOR_COMPATIBILITY_PROFILE.arrayPaths) {
  if (!ARRAY_PATHS.includes(schemaPath)) ARRAY_PATHS.push(schemaPath);
}
for (const [types, paths] of GENERATOR_COMPATIBILITY_PROFILE.scalarTypes) {
  for (const schemaPath of paths) addScalarTypes(schemaPath, types);
}

const DESCRIPTOR_DIGEST = "cd2538e77f1abbe5aabe750e0a4ecda1807e006cecc2fc6acc03296dd7f2eabf";

const DESCRIPTOR = {
  name: "typescript",
  descriptorDigest: DESCRIPTOR_DIGEST,
  objectRules: OBJECT_RULES,
  arrayPaths: ARRAY_PATHS,
  scalarTypeGroups: SCALAR_TYPE_GROUPS,
};

module.exports = deepFreeze(DESCRIPTOR);
