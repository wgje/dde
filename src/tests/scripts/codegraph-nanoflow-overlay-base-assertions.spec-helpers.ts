import { expect } from 'vitest';

type ParsedOverlay = ReturnType<typeof JSON.parse>;

export function assertBaseOverlayAngularAndGraph(overlay: ParsedOverlay, root: string): void {
    expect(overlay.schemaVersion).toBe(1);
    expect(overlay.project.root).toBe(root);
    expect(overlay.graph.nodes.every((node: { updatedAt?: unknown }) => typeof node.updatedAt === 'number')).toBe(true);
    expect(overlay.coverageTargets).toEqual(expect.arrayContaining([
      'Angular hostDirectives metadata',
      'Angular viewChild()/viewChildren()/contentChild()/contentChildren()/signal()/computed()/effect() signal edges',
      'Angular host metadata object attribute/binding/listener edges',
      'Angular application bootstrap provider edges',
      'Angular route component/loadComponent/loadChildren edges',
      'Supabase Edge Function source/helper import references',
      'Supabase Edge Function route and HTTP method references',
      'Supabase Edge Function test mappings',
      'Supabase migration privilege grant/revoke anchors',
      'AGENTS.md sync-rule anchors',
      'Native JavaScript-family export/default/CommonJS object function members',
    ]));

    expect(overlay.angular.components).toEqual([
      expect.objectContaining({
        className: 'SampleComponent',
        selector: 'app-sample',
        standalone: true,
        changeDetection: 'OnPush',
        imports: ['LazyPanelComponent'],
        providers: ['SampleService'],
        hostDirectives: [
          expect.objectContaining({ directive: 'SampleHostDirective', inputs: [], outputs: [] }),
          expect.objectContaining({
            directive: 'SampleBehaviorDirective',
            inputs: ['mode: hostMode'],
            outputs: ['closed: hostClosed'],
          }),
        ],
        templateUrl: 'src/app/features/sample/sample.component.html',
        styleUrls: ['src/app/features/sample/sample.component.css'],
        dependencies: ['SampleService', 'SampleRepository'],
        constructorDependencies: ['SampleRepository'],
        dynamicImports: ['src/app/features/sample/lazy-panel.component.ts'],
        tests: ['src/app/features/sample/sample.component.spec.ts'],
        testMappings: [
          expect.objectContaining({
            file: 'src/app/features/sample/sample.component.spec.ts',
            testMapping: 'same-basename',
          }),
        ],
        inputs: expect.arrayContaining([
          expect.objectContaining({ name: 'title', api: 'input.required' }),
          expect.objectContaining({ name: 'disabled', api: 'input' }),
          expect.objectContaining({ name: 'legacyName', api: '@Input' }),
        ]),
        outputs: expect.arrayContaining([
          expect.objectContaining({ name: 'saved', api: 'output' }),
          expect.objectContaining({ name: 'legacySaved', api: '@Output' }),
        ]),
        models: [expect.objectContaining({ name: 'value', api: 'model' })],
        queries: expect.arrayContaining([
          expect.objectContaining({ name: 'panel', api: 'viewChild', target: 'LazyPanelComponent' }),
          expect.objectContaining({ name: 'panels', api: 'viewChildren', target: 'LazyPanelComponent' }),
          expect.objectContaining({ name: 'slot', api: 'contentChild', target: 'slot' }),
          expect.objectContaining({ name: 'slots', api: 'contentChildren', target: 'slot' }),
        ]),
        signals: expect.arrayContaining([
          expect.objectContaining({ name: 'dirty', api: 'signal' }),
          expect.objectContaining({ name: 'label', api: 'computed' }),
          expect.objectContaining({ name: 'constructor', api: 'effect' }),
        ]),
        hostAttributes: [
          expect.objectContaining({ name: 'role', value: 'slider', api: 'host' }),
        ],
        hostBindings: expect.arrayContaining([
          expect.objectContaining({ name: 'active', binding: 'class.active', api: '@HostBinding' }),
          expect.objectContaining({
            name: 'title',
            binding: 'attr.aria-label',
            expression: 'title()',
            api: 'host',
            kind: 'attribute',
          }),
          expect.objectContaining({
            name: 'active',
            binding: 'class.active',
            expression: 'active',
            api: 'host',
            kind: 'class',
          }),
        ]),
        hostListeners: expect.arrayContaining([
          expect.objectContaining({ name: 'save', event: 'click', api: '@HostListener' }),
          expect.objectContaining({ name: 'save', event: 'keydown', expression: 'save($event)', api: 'host' }),
        ]),
        templateBindings: expect.arrayContaining([
          expect.objectContaining({ name: 'disabled', kind: 'property' }),
          expect.objectContaining({ name: 'save', kind: 'event' }),
          expect.objectContaining({ name: 'title', kind: 'interpolation' }),
          expect.objectContaining({ name: 'value', kind: 'property' }),
          expect.objectContaining({ name: 'isVisible', kind: 'control-flow' }),
          expect.objectContaining({ name: 'shouldDeferPanel', kind: 'control-flow' }),
          expect.objectContaining({ name: 'shouldPrefetchPanel', kind: 'control-flow' }),
          expect.objectContaining({ name: 'caseLabel', kind: 'control-flow' }),
          expect.objectContaining({ name: 'items', kind: 'control-flow' }),
          expect.objectContaining({ name: 'trackItemId', kind: 'control-flow' }),
          expect.objectContaining({ name: 'label', kind: 'interpolation' }),
          expect.objectContaining({ name: 'formatItemName', kind: 'interpolation' }),
          expect.objectContaining({ name: 'items', kind: 'structural' }),
          expect.objectContaining({ name: 'trackItemId', kind: 'structural' }),
        ]),
      }),
    ]);
    const sampleComponent = overlay.angular.components.find(
      (component: { className?: string }) => component.className === 'SampleComponent',
    );
    const templateBindingNames = (sampleComponent?.templateBindings ?? [])
      .map((binding: { name?: string }) => binding.name);
    expect(templateBindingNames).not.toContain('visibleTitle');
    expect(templateBindingNames).not.toContain('ngIfTitle');
    expect(templateBindingNames).not.toContain('sampleTitle');
    expect(templateBindingNames).not.toContain('index');
    expect(templateBindingNames).not.toContain('even');
    expect(templateBindingNames).not.toContain('count');
    expect(templateBindingNames).not.toContain('viewport');
    expect(templateBindingNames).not.toContain('idle');
    expect(templateBindingNames).not.toContain('timer');
    expect(templateBindingNames).not.toContain('ms');
    expect(overlay.angular.injectors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'src/app/features/sample/sample.component.ts',
        dependencies: ['SampleService', 'SampleRepository'],
      }),
      expect.objectContaining({
        file: 'src/app/features/sample/sample.service.ts',
        dependencies: ['SampleRepository'],
      }),
    ]));
    expect(overlay.angular.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '',
        file: 'src/app/app.routes.ts',
        redirectTo: 'panel',
        pathMatch: 'full',
      }),
      expect.objectContaining({
        path: 'sample',
        file: 'src/app/app.routes.ts',
        loadComponent: 'src/app/features/sample/sample.component.ts',
        exportName: 'SampleComponent',
        providers: expect.arrayContaining([
          expect.objectContaining({ name: 'SampleRouteProvider' }),
        ]),
      }),
      expect.objectContaining({
        path: 'panel',
        file: 'src/app/app.routes.ts',
        component: 'LazyPanelComponent',
      }),
      expect.objectContaining({
        path: 'child',
        file: 'src/app/app.routes.ts',
        loadChildren: 'src/app/features/sample/lazy-child.routes.ts',
        exportName: 'childRoutes',
      }),
      expect.objectContaining({
        path: 'unresolved-child',
        file: 'src/app/app.routes.ts',
        loadChildren: 'src/app/features/sample/lazy-child.routes.ts',
        exportName: 'missingRoutes',
      }),
    ]));
    expect(overlay.angular.applicationProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'main.ts',
        bootstrapComponent: 'AppComponent',
        providers: expect.arrayContaining([
          expect.objectContaining({
            name: 'ErrorHandler',
            providerKind: 'object',
            useClass: 'GlobalErrorHandler',
          }),
          expect.objectContaining({
            name: 'APP_INITIALIZER',
            providerKind: 'object',
            deps: ['SampleService'],
          }),
          expect.objectContaining({
            name: 'provideRouter',
            providerKind: 'factory-call',
            arguments: expect.arrayContaining(['routes', 'withHashLocation']),
          }),
          expect.objectContaining({
            name: 'provideServiceWorker',
            providerKind: 'factory-call',
            arguments: expect.arrayContaining(['ngsw-worker.js']),
          }),
        ]),
      }),
    ]));
    expect(overlay.angular.injectables).toEqual([
      expect.objectContaining({
        className: 'SampleService',
        file: 'src/app/features/sample/sample.service.ts',
        providedIn: 'root',
        dependencies: ['SampleRepository'],
        tests: ['src/app/features/sample/sample.component.spec.ts'],
        testMappings: [
          expect.objectContaining({
            file: 'src/app/features/sample/sample.component.spec.ts',
            testMapping: 'class-reference',
          }),
        ],
      }),
    ]);
    expect(overlay.angular.directives).toEqual(expect.arrayContaining([
      expect.objectContaining({
        className: 'SampleDirective',
        selector: '[appSample]',
        standalone: true,
        inputs: [expect.objectContaining({ name: 'flag', api: 'input' })],
        hostListeners: [expect.objectContaining({ name: 'enter', event: 'mouseenter' })],
      }),
    ]));
    expect(overlay.angular.pipes).toEqual([
      expect.objectContaining({
        className: 'SampleTitlePipe',
        name: 'sampleTitle',
        standalone: true,
        pure: true,
      }),
    ]);
    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'SampleComponent',
        filePath: 'src/app/features/sample/sample.component.ts',
        language: 'typescript',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'SampleService',
        filePath: 'src/app/features/sample/sample.service.ts',
      }),
      expect.objectContaining({
        kind: 'route',
        name: 'sample',
        filePath: 'src/app/app.routes.ts',
      }),
      expect.objectContaining({
        kind: 'route',
        name: 'child',
        filePath: 'src/app/app.routes.ts',
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'SamplePort',
        filePath: 'src/app/features/sample/sample-domain.ts',
        docstring: 'Contract implemented by sample entities.',
      }),
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleAlias',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'SAMPLE_LIMIT',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'enum',
        name: 'SampleStatus',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'enum_member',
        name: 'Ready',
        qualifiedName: 'SampleStatus::Ready',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'status',
        qualifiedName: 'SampleEntity::status',
        filePath: 'src/app/features/sample/sample-domain.ts',
        signature: expect.stringContaining('status: SampleStatus'),
        isStatic: false,
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'saveLater',
        qualifiedName: 'SampleEntity::saveLater',
        filePath: 'src/app/features/sample/sample-domain.ts',
        signature: expect.stringContaining('SampleEntity'),
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'constructor',
        qualifiedName: 'SampleEntity::constructor',
        filePath: 'src/app/features/sample/sample-domain.ts',
        signature: expect.stringContaining('SampleAlias'),
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'statusLabel',
        qualifiedName: 'SampleEntity::statusLabel',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'save',
        qualifiedName: 'SampleEntity::save',
        filePath: 'src/app/features/sample/sample-domain.ts',
        docstring: 'Saves through the sample port contract.',
        decorators: ['Trace'],
        returnType: 'SampleEntity',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createSample',
        filePath: 'src/app/features/sample/sample-domain.ts',
        docstring: 'Creates a concrete sample entity.',
        returnType: 'SampleEntity',
        endLine: expect.any(Number),
        startColumn: expect.any(Number),
        endColumn: expect.any(Number),
        isExported: true,
        isAsync: false,
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createSampleArrow',
        filePath: 'src/app/features/sample/sample-domain.ts',
        isExported: true,
        signature: expect.stringContaining('SampleEntity'),
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createSampleFunction',
        filePath: 'src/app/features/sample/sample-domain.ts',
        isExported: true,
        signature: expect.stringContaining('SampleEntity'),
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'sampleReadyStatus',
        filePath: 'src/app/features/sample/sample-domain.ts',
        isExported: true,
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'firstSampleStatus',
        filePath: 'src/app/features/sample/sample-domain.ts',
        isExported: true,
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'namespacedPort',
        filePath: 'src/app/features/sample/sample-domain.ts',
        isExported: true,
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'InlineEntity',
        filePath: 'src/app/features/sample/sample-domain.ts',
        isExported: true,
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'SampleEntity',
        filePath: 'src/app/features/sample/sample-domain.ts',
        docstring: 'Entity persisted through SamplePort.',
        decorators: ['Trace'],
        isExported: true,
        isAbstract: false,
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'GenericSamplePort',
        filePath: 'src/app/features/sample/sample-domain.ts',
        typeParameters: ['TPort'],
      }),
      expect.objectContaining({
        kind: 'type_alias',
        name: 'GenericSampleAlias',
        filePath: 'src/app/features/sample/sample-domain.ts',
        typeParameters: ['TPort'],
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createGenericSample',
        filePath: 'src/app/features/sample/sample-domain.ts',
        typeParameters: ['TPort'],
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'GenericSampleEntity',
        filePath: 'src/app/features/sample/sample-domain.ts',
        typeParameters: ['TPort'],
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'overloadSample',
        filePath: 'src/app/features/sample/sample-domain.ts',
        metadata: expect.objectContaining({ overloads: 2 }),
      }),
      expect.objectContaining({
        kind: 'namespace',
        name: 'SampleNamespace',
        filePath: 'src/app/features/sample/sample-domain.ts',
        docstring: 'Namespace for sample contracts.',
      }),
      expect.objectContaining({
        kind: 'namespace',
        name: 'SampleNamespace.Nested',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'InnerPort',
        qualifiedName: 'SampleNamespace.Nested::InnerPort',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'SampleView',
        filePath: 'src/app/features/sample/sample-view.tsx',
        language: 'tsx',
      }),
      expect.objectContaining({
        kind: 'import',
        name: 'SampleRepository',
        filePath: 'src/app/features/sample/sample-domain.ts',
        metadata: expect.objectContaining({
          importedName: 'SampleRepository',
          isTypeOnly: false,
        }),
      }),
      expect.objectContaining({
        kind: 'export',
        name: 'SampleEntity',
        filePath: 'src/app/features/sample/sample-domain.ts',
        metadata: expect.objectContaining({
          exportName: 'SampleEntity',
        }),
      }),
      expect.objectContaining({
        kind: 'parameter',
        name: 'value',
        qualifiedName: 'createSample::value',
        filePath: 'src/app/features/sample/sample-domain.ts',
      }),
    ]));
    expect(overlay.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        metadata: expect.objectContaining({ relation: 'file-symbol' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        metadata: expect.objectContaining({ relation: 'class-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        metadata: expect.objectContaining({ relation: 'enum-member' }),
      }),
      expect.objectContaining({
        kind: 'imports',
        metadata: expect.objectContaining({
          relation: 'template-url',
          angularProperty: 'templateUrl',
          legacyRelation: 'templateUrl',
        }),
      }),
      expect.objectContaining({
        kind: 'imports',
        metadata: expect.objectContaining({
          relation: 'style-url',
          angularProperty: 'styleUrl',
          legacyRelation: 'styleUrl',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        metadata: expect.objectContaining({ relation: 'dependency' }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({ relation: 'test' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'file:src/app/features/sample/sample.component.spec.ts:src/app/features/sample/sample.component.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'same-basename',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.service.ts:SampleService',
        target: 'file:src/app/features/sample/sample.component.spec.ts:src/app/features/sample/sample.component.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'class-reference',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleBehaviorDirective',
        metadata: expect.objectContaining({
          relation: 'host-directive',
          inputs: ['mode: hostMode'],
          outputs: ['closed: hostClosed'],
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({
          relation: 'host-attribute',
          api: 'host',
          attribute: 'role',
          value: 'slider',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({
          relation: 'host-binding',
          api: 'host',
          binding: 'attr.aria-label',
          expression: 'title()',
        }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({
          relation: 'host-listener',
          api: 'host',
          event: 'keydown',
          expression: 'save($event)',
        }),
      }),
      expect.objectContaining({
        kind: 'imports',
        metadata: expect.objectContaining({ relation: 'import' }),
      }),
      expect.objectContaining({
        kind: 'exports',
        metadata: expect.objectContaining({ relation: 'export' }),
      }),
      expect.objectContaining({
        kind: 'extends',
        metadata: expect.objectContaining({ relation: 'extends' }),
      }),
      expect.objectContaining({
        kind: 'implements',
        metadata: expect.objectContaining({ relation: 'implements' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
      expect.objectContaining({
        kind: 'returns',
        metadata: expect.objectContaining({ relation: 'return-type' }),
      }),
      expect.objectContaining({
        kind: 'instantiates',
        metadata: expect.objectContaining({ relation: 'new' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'exports',
        metadata: expect.objectContaining({ relation: 're-export' }),
      }),
      expect.objectContaining({
        kind: 'decorates',
        source: 'class:src/app/features/sample/sample-domain.ts:SampleEntity',
        target: 'function:src/app/features/sample/sample-domain.ts:Trace',
        line: expect.any(Number),
        column: expect.any(Number),
        metadata: expect.objectContaining({ relation: 'decorator' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample-domain.ts:SampleEntity',
        target: 'enum:src/app/features/sample/sample-domain.ts:SampleStatus',
        metadata: expect.objectContaining({ relation: 'decorator-argument' }),
      }),
      expect.objectContaining({
        kind: 'decorates',
        source: 'method:src/app/features/sample/sample-domain.ts:SampleEntity.save',
        target: 'function:src/app/features/sample/sample-domain.ts:Trace',
        line: expect.any(Number),
        column: expect.any(Number),
        metadata: expect.objectContaining({ relation: 'decorator' }),
      }),
      expect.objectContaining({
        kind: 'overrides',
        source: 'method:src/app/features/sample/sample-domain.ts:SampleEntity.save',
        target: 'method:src/app/features/sample/sample-domain.ts:BaseEntity.save',
        metadata: expect.objectContaining({ relation: 'override' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'method:src/app/features/sample/sample-domain.ts:SamplePort.save',
        target: 'method:src/app/features/sample/sample-domain.ts:SampleEntity.save',
        provenance: 'heuristic',
        metadata: expect.objectContaining({
          synthesizedBy: 'interface-impl',
          via: 'save',
          registeredAt: expect.stringMatching(/^src\/app\/features\/sample\/sample-domain\.ts:\d+$/),
        }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'method:src/app/features/sample/sample-domain.ts:BaseEntity.save',
        target: 'method:src/app/features/sample/sample-domain.ts:SampleEntity.save',
        provenance: 'heuristic',
        metadata: expect.objectContaining({
          synthesizedBy: 'interface-impl',
          via: 'save',
          registeredAt: expect.stringMatching(/^src\/app\/features\/sample\/sample-domain\.ts:\d+$/),
        }),
      }),
      expect.objectContaining({
        kind: 'instantiates',
        source: 'class:src/app/features/sample/sample-domain.ts:SampleEntity',
        target: 'class:src/app/features/sample/sample.repository.ts:SampleRepository',
        metadata: expect.objectContaining({ relation: 'new' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: 'property:src/app/features/sample/sample-domain.ts:SampleEntity.status',
        target: 'enum:src/app/features/sample/sample-domain.ts:SampleStatus',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'method:src/app/features/sample/sample-domain.ts:SampleEntity.saveLater',
        target: 'function:src/app/features/sample/sample-domain.ts:createSample',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: 'constant:src/app/features/sample/sample-domain.ts:namespacedPort',
        target: 'interface:src/app/features/sample/sample-domain.ts:SampleNamespace.Nested::InnerPort',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: 'function:src/app/features/sample/sample-domain.ts:createSample',
        target: 'parameter:src/app/features/sample/sample-domain.ts:createSample.value',
        metadata: expect.objectContaining({ relation: 'parameter' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: 'parameter:src/app/features/sample/sample-domain.ts:createSample.value',
        target: 'type_alias:src/app/features/sample/sample-domain.ts:SampleAlias',
        metadata: expect.objectContaining({ relation: 'parameter-type' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'constant:src/app/features/sample/sample-domain.ts:sampleRegistry',
        target: 'class:src/app/features/sample/sample-domain.ts:SampleEntity',
        metadata: expect.objectContaining({ relation: 'initializer-reference' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'constant:src/app/features/sample/sample-domain.ts:sampleFactories',
        target: 'function:src/app/features/sample/sample-domain.ts:createSample',
        metadata: expect.objectContaining({ relation: 'initializer-reference' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/sample-view.tsx:SampleView',
        target: 'class:src/app/features/sample/lazy-panel.component.ts:LazyPanelComponent',
        metadata: expect.objectContaining({ relation: 'jsx-component' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'file:main.ts:main.ts',
        metadata: expect.objectContaining({
          relation: 'angular-app-provider',
          provider: 'APP_INITIALIZER',
          deps: ['SampleService'],
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'file:main.ts:main.ts',
        metadata: expect.objectContaining({
          relation: 'angular-app-provider',
          provider: 'provideRouter',
          providerKind: 'factory-call',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'file:main.ts:main.ts',
        metadata: expect.objectContaining({
          relation: 'angular-app-provider',
          provider: 'provideServiceWorker',
          providerKind: 'factory-call',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'route:src/app/app.routes.ts:child',
        target: 'constant:src/app/features/sample/lazy-child.routes.ts:childRoutes',
        metadata: expect.objectContaining({
          relation: 'route',
          path: 'child',
          exportName: 'childRoutes',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'route:src/app/app.routes.ts:unresolved-child',
        target: 'file:src/app/features/sample/lazy-child.routes.ts:src/app/features/sample/lazy-child.routes.ts',
        metadata: expect.objectContaining({
          relation: 'route',
          path: 'unresolved-child',
          exportName: 'missingRoutes',
        }),
      }),
    ]));
    const nativeEdgeKinds = new Set([
      'contains',
      'calls',
      'imports',
      'exports',
      'extends',
      'implements',
      'references',
      'type_of',
      'returns',
      'instantiates',
      'overrides',
      'decorates',
    ]);
    expect(overlay.graph.edges.every((edge: { kind: string }) => nativeEdgeKinds.has(edge.kind))).toBe(true);

}
