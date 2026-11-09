/*
 *  Copyright 1998-2026 by Northwoods Software Corporation. All Rights Reserved.
 *
 *  This file is VENDORED from the official GoJS extensions (extensionsJSM/AvoidsLinksRouter.ts).
 *  Source: https://github.com/NorthwoodsSoftware/GoJS/blob/master/extensionsJSM/AvoidsLinksRouter.ts
 *
 *  The API for this class may change with any GoJS version, even point releases.
 *  When upgrading gojs, re-vendor this file from the matching GoJS tag.
 *
 *  ========== NanoFlow 使用说明 ==========
 *  - 仅作用于 `link.isOrthogonal === true` 的连线（参见 isRoutable）。
 *  - 对 Bezier / Normal routing 的连线是 no-op；要让它真正生效，
 *    需要把对应 link template 的 routing 切到 go.Link.Orthogonal。
 *  - 默认通过 LAYOUT_CONFIG.AUTO_LAYOUT_ENABLE_AVOIDS_LINKS_ROUTER 开关控制，
 *    避免一装就改变现有视觉风格。
 */

import * as go from 'gojs';

interface SegmentCollectionScope {
  enclosingRect: go.Rect | null;
  skipBounds: boolean;
}

interface GridlineAdjustmentBounds {
  vertical: boolean;
  maxLayer: number;
  minColumn: number;
  maxColumn: number;
  minCoord: number;
  maxCoord: number;
}

type SegmentAxis = 'x' | 'y';

interface ColumnRange {
  start: number;
  end: number;
}

type EndpointRangeRelation =
  | 'secondContainsFirst'
  | 'firstContainsSecond'
  | 'secondStartsBeforeFirst'
  | 'firstStartsBeforeSecond'
  | 'none';

interface EndpointComparison {
  relation: EndpointRangeRelation;
  geo: number;
  startEqual: boolean;
  endEqual: boolean;
}

/**
 * A custom Router that will cause overlapping segments of Orthogonal or AvoidsNodes links to be routed in parallel,
 * while minimizing resulting crossings between links.
 *
 * The maximum distance that resulting sets of links will be spread apart is given by {@link AvoidsLinksRouter.linkSpacing}.
 *
 * By default the router will reduce the space between parallel segments to prevent them from overlapping nearby Nodes,
 * however this behavior can be disabled by setting {@link AvoidsLinksRouter.avoidsNodes} to false.
 * If that property is set to false, then all modified sets of links will be at a distance of exactly {@link AvoidsLinksRouter.linkSpacing},
 * even if this causes some of the links to overlap a nearby Node.
 *
 * Typical setup:
 * ```
 *   myDiagram.routers.add(new AvoidsLinksRouter());
 * ```
 *
 * @category Router Extension
 */
export class AvoidsLinksRouter extends go.Router {
  private _linkSpacing: number;
  private _allsegs: go.List<go.List<_SegInfo>>;
  private _gridlines: go.List<go.List<_SegInfo>>;
  private _segs: go.List<_SegInfo>;
  private _avoidsNodes: boolean;
  private _epsilonDistance: number;
  private _iterations: number;
  private _ignoreContainingGroups: boolean;

  constructor(init?: Partial<AvoidsLinksRouter>) {
    super();
    this.name = 'AvoidsLinksRouter';
    this._linkSpacing = 4;
    this._allsegs = new go.List();
    this._gridlines = new go.List();
    this._segs = new go.List();
    this._avoidsNodes = true;
    this._epsilonDistance = 0.5;
    this._iterations = 1;
    this._ignoreContainingGroups = false;
    if (init) Object.assign(this, init);
  }

  get linkSpacing(): number {
    return this._linkSpacing;
  }
  set linkSpacing(value: number) {
    if (value !== this._linkSpacing) {
      if (typeof value !== 'number') throw new Error('AvoidsLinksRouter.linkSpacing must be a number');
      this._linkSpacing = value;
      this.invalidateRouter();
    }
  }

  get avoidsNodes(): boolean {
    return this._avoidsNodes;
  }
  set avoidsNodes(value: boolean) {
    value = !!value;
    if (value !== this._avoidsNodes) {
      this._avoidsNodes = value;
      this.invalidateRouter();
    }
  }

  get epsilonDistance(): number {
    return this._epsilonDistance;
  }
  set epsilonDistance(value: number) {
    if (value !== this._epsilonDistance) {
      if (typeof value !== 'number') throw new Error('AvoidsLinksRouter.epsilonDistance must be a number');
      this._epsilonDistance = value;
      this.invalidateRouter();
    }
  }

  get iterations(): number {
    return this._iterations;
  }
  set iterations(value: number) {
    if (value !== this._iterations) {
      if (typeof value !== 'number') throw new Error('AvoidsLinksRouter.iterations must be a number');
      this._iterations = value;
      this.invalidateRouter();
    }
  }

  get ignoreContainingGroups(): boolean {
    return this._ignoreContainingGroups;
  }
  set ignoreContainingGroups(value: boolean) {
    value = !!value;
    if (value !== this._ignoreContainingGroups) {
      this._ignoreContainingGroups = value;
      this.invalidateRouter();
    }
  }

  override canRoute(container: go.Group | go.Diagram): boolean {
    if (this._ignoreContainingGroups && container instanceof go.Group) return false;
    return super.canRoute(container);
  }

  override isRoutable(link: go.Link, container: go.Diagram | go.Group): boolean {
    if (!link.isOrthogonal) return false;
    if (link.pointsCount < 3) return false;
    if (!this._ignoreContainingGroups) {
      if (link.containingGroup !== (container instanceof go.Group ? container : null)) return false;
    }
    return true;
  }

  override routeLinks(links: go.Set<go.Link>, container: go.Diagram | go.Group): void {
    const diagram = this.diagram;
    if (diagram === null) return;
    for (let i = 0; i < this.iterations; i++) {
      this._allsegs = new go.List();
      this._gridlines = new go.List();
      this.collectSegments(links, container);
      let positions: go.PositionArray | null = null;
      if (this._avoidsNodes) {
        positions = diagram.getPositions(true, null, null);
      }
      this.adjustOverlaps(positions);

      for (const line of this._allsegs) {
        for (const seg of line) this._freeSegInfo(seg);
      }
      for (const line of this._gridlines) {
        for (const seg of line) this._freeSegInfo(seg);
      }
    }
  }

  /** @internal */
  _allocSegInfo(): _SegInfo {
    const si = this._segs.pop();
    if (si) return si;
    return new _SegInfo();
  }

  /** @internal */
  _freeSegInfo(si: _SegInfo): void {
    si.link = null;
    this._segs.push(si);
  }

  /** @internal */
  _coord(si: _SegInfo): number {
    return si.vertical ? si.link!.getPoint(si.indexStart).x : si.link!.getPoint(si.indexStart).y;
  }

  /** @internal */
  _columnStart(si: _SegInfo): number {
    return si.vertical ? si.link!.getPoint(si.indexStart).y : si.link!.getPoint(si.indexStart).x;
  }

  /** @internal */
  _columnEnd(si: _SegInfo): number {
    return si.vertical ? si.link!.getPoint(si.indexEnd).y : si.link!.getPoint(si.indexEnd).x;
  }

  /** @internal */
  nextOrthoBend(link: go.Link, index: number): number {
    if (link.pointsCount < 3) return 0;
    let p = link.getPoint(index);
    let q = link.getPoint(index + 1);
    let i = index;
    const vertical = this.isApprox(p.x, q.x) && !this.isApprox(p.y, q.y);
    while (i < link.pointsCount - 2) {
      i++;
      p = link.getPoint(i);
      q = link.getPoint(i + 1);
      if (vertical !== (this.isApprox(p.x, q.x) && !this.isApprox(p.y, q.y))) return i;
    }
    return link.pointsCount - 1;
  }

  /** @internal */
  collectSegments(links: go.Set<go.Link>, coll: go.Diagram | go.Group): void {
    this._allsegs.clear();
    this._gridlines.clear();

    const scope = this.collectRoutableLinkSegments(links, coll);
    this.collectNearbyLinkSegments(links, scope);
    this.buildGridlinesFromCollectedSegments();
  }

  private collectRoutableLinkSegments(
    links: go.Set<go.Link>,
    coll: go.Diagram | go.Group,
  ): SegmentCollectionScope {
    const skipBounds = coll instanceof go.Diagram && links.count === coll.links.count;
    let enclosingRect: go.Rect | null = null;

    for (const link of links) {
      if (!this.isRoutable(link, coll)) continue;
      enclosingRect = this.expandEnclosingRect(enclosingRect, link, skipBounds);
      this.collectPrimarySegmentsForLink(link);
    }

    return { enclosingRect, skipBounds };
  }

  private expandEnclosingRect(enclosingRect: go.Rect | null, link: go.Link, skipBounds: boolean): go.Rect | null {
    if (skipBounds) return enclosingRect;
    if (enclosingRect === null) return link.getDocumentBounds();
    enclosingRect.unionRect(link.getDocumentBounds());
    return enclosingRect;
  }

  private collectPrimarySegmentsForLink(link: go.Link): void {
    let startIndex = this.nextOrthoBend(link, 0);
    while (startIndex < link.pointsCount - 1) {
      const endIndex = this.nextOrthoBend(link, startIndex);
      if (endIndex === link.pointsCount - 1) break;

      this.addSegmentToAllSegments(this.createSegmentInfo(link, startIndex, endIndex));
      startIndex = endIndex;
    }
  }

  private createSegmentInfo(link: go.Link, startIndex: number, endIndex: number): _SegInfo {
    const startPoint = link.getPoint(startIndex);
    const endPoint = link.getPoint(endIndex);
    const seginfo = this._allocSegInfo();
    seginfo.indexStart = startIndex;
    seginfo.indexEnd = endIndex;
    seginfo.link = link;
    seginfo.vertical = this.isVerticalSegment(startPoint, endPoint);
    seginfo._computeGeo();
    return seginfo;
  }

  private isVerticalSegment(startPoint: go.Point, endPoint: go.Point): boolean {
    return this.isApprox(startPoint.x, endPoint.x) && !this.isApprox(startPoint.y, endPoint.y);
  }

  private addSegmentToAllSegments(seginfo: _SegInfo): void {
    const matchingLine = this.findMatchingSegmentLine(seginfo.vertical, this._coord(seginfo));
    if (matchingLine) {
      matchingLine.add(seginfo);
      return;
    }

    this._allsegs.add(new go.List([seginfo]));
  }

  private findMatchingSegmentLine(vertical: boolean, coord: number): go.List<_SegInfo> | null {
    for (const line of this._allsegs) {
      const firstSegment = line.first();
      if (firstSegment && this.isMatchingSegmentLine(firstSegment, vertical, coord)) {
        return line;
      }
    }
    return null;
  }

  private isMatchingSegmentLine(firstSegment: _SegInfo, vertical: boolean, coord: number): boolean {
    return firstSegment.vertical === vertical && Math.abs(this._coord(firstSegment) - coord) < this._epsilonDistance;
  }

  private collectNearbyLinkSegments(links: go.Set<go.Link>, scope: SegmentCollectionScope): void {
    if (scope.enclosingRect === null || scope.skipBounds || this.diagram === null) return;

    for (const part of this.diagram.findPartsIn(scope.enclosingRect, true)) {
      if (this.shouldCollectNearbyLink(part, links)) {
        this.collectTrackedNearbySegmentsForLink(part);
      }
    }
  }

  private shouldCollectNearbyLink(part: go.Part, links: go.Set<go.Link>): part is go.Link {
    return part instanceof go.Link && part.isOrthogonal && !links.has(part);
  }

  private collectTrackedNearbySegmentsForLink(link: go.Link): void {
    let startIndex = this.nextOrthoBend(link, 0);
    while (startIndex < link.pointsCount - 1) {
      const endIndex = this.nextOrthoBend(link, startIndex);
      if (endIndex === link.pointsCount - 1) break;

      this.addNearbySegmentIfTracked(link, startIndex, endIndex);
      startIndex = endIndex;
    }
  }

  private addNearbySegmentIfTracked(link: go.Link, startIndex: number, endIndex: number): void {
    const startPoint = link.getPoint(startIndex);
    const endPoint = link.getPoint(endIndex);
    const vertical = this.isVerticalSegment(startPoint, endPoint);
    const coord = vertical ? startPoint.x : startPoint.y;
    const matchingLine = this.findMatchingSegmentLine(vertical, coord);
    if (matchingLine) {
      matchingLine.add(this.createSegmentInfo(link, startIndex, endIndex));
    }
  }

  private buildGridlinesFromCollectedSegments(): void {
    for (const line of this._allsegs) {
      this.buildGridlinesFromSegmentLine(line);
    }
  }

  private buildGridlinesFromSegmentLine(line: go.List<_SegInfo>): void {
    while (line.count > 0) {
      const newline = new go.List([line.pop()!]);
      this.expandGridline(line, newline);
      this._gridlines.add(newline);
    }
  }

  private expandGridline(line: go.List<_SegInfo>, newline: go.List<_SegInfo>): void {
    let found = true;
    while (found) {
      found = false;
      for (const otherseg of newline) {
        const overlappingSegment = this.findOverlappingSegment(line, otherseg);
        if (!overlappingSegment) continue;

        line.remove(overlappingSegment);
        newline.push(overlappingSegment);
        found = true;
        break;
      }
    }
  }

  private findOverlappingSegment(line: go.List<_SegInfo>, otherseg: _SegInfo): _SegInfo | null {
    for (const seginfo of line) {
      if (seginfo.link !== otherseg.link && this.segmentsOverlapInColumn(seginfo, otherseg)) {
        return seginfo;
      }
    }
    return null;
  }

  private segmentsOverlapInColumn(seginfo: _SegInfo, otherseg: _SegInfo): boolean {
    const minI = Math.min(this._columnStart(seginfo), this._columnEnd(seginfo));
    const maxI = Math.max(this._columnStart(seginfo), this._columnEnd(seginfo));
    const minJ = Math.min(this._columnStart(otherseg), this._columnEnd(otherseg));
    const maxJ = Math.max(this._columnStart(otherseg), this._columnEnd(otherseg));
    return minJ <= maxI && minI <= maxJ;
  }

  /** @internal */
  adjustOverlaps(positions: go.PositionArray | null): void {
    for (const line of this._gridlines) {
      const gridline = this.prepareGridlineForAdjustment(line);
      if (!gridline) continue;

      const bounds = this.createGridlineAdjustmentBounds(gridline);
      const realSpacing = this.resolveGridlineSpacing(bounds, positions);
      this.applyGridlineSpacing(gridline, bounds, realSpacing);
    }
  }

  private prepareGridlineForAdjustment(line: go.List<_SegInfo>): _SegInfo[] | null {
    if (line.count < 2) return null;
    const gridline = line.toArray();
    this.sortGridline(gridline);
    return gridline;
  }

  private createGridlineAdjustmentBounds(gridline: _SegInfo[]): GridlineAdjustmentBounds {
    const firstSegment = gridline[0];
    const maxLayer = gridline.length - 1;
    const firstRange = this.getColumnRange(firstSegment);
    let minColumn = firstRange.start;
    let maxColumn = firstRange.end;

    for (let i = 1; i < gridline.length; i++) {
      const range = this.getColumnRange(gridline[i]);
      minColumn = Math.min(minColumn, range.start);
      maxColumn = Math.max(maxColumn, range.end);
    }

    const coord = this._coord(firstSegment);
    return {
      vertical: firstSegment.vertical,
      maxLayer,
      minColumn,
      maxColumn,
      minCoord: coord - (maxLayer * this._linkSpacing) / 2,
      maxCoord: coord + (maxLayer * this._linkSpacing) / 2,
    };
  }

  private resolveGridlineSpacing(bounds: GridlineAdjustmentBounds, positions: go.PositionArray | null): number {
    if (!this._avoidsNodes || bounds.maxLayer <= 0 || !positions) {
      return this._linkSpacing;
    }

    const realSpacing = bounds.vertical
      ? this.resolveVerticalGridlineSpacing(bounds, positions)
      : this.resolveHorizontalGridlineSpacing(bounds, positions);
    return realSpacing === 0 ? this._linkSpacing : realSpacing;
  }

  private resolveVerticalGridlineSpacing(bounds: GridlineAdjustmentBounds, positions: go.PositionArray): number {
    if (positions.isUnoccupied(
      bounds.minCoord,
      bounds.minColumn,
      bounds.maxCoord - bounds.minCoord,
      bounds.maxColumn - bounds.minColumn,
    )) {
      return this._linkSpacing;
    }

    const availSpace = positions.maxAvoidsLinksSpaceV(
      bounds.minColumn,
      bounds.maxColumn,
      (bounds.minCoord + bounds.maxCoord) / 2,
      bounds.maxCoord - bounds.minCoord,
    );
    return Math.min(this._linkSpacing, (2 * availSpace) / (1 + bounds.maxLayer));
  }

  private resolveHorizontalGridlineSpacing(bounds: GridlineAdjustmentBounds, positions: go.PositionArray): number {
    if (positions.isUnoccupied(
      bounds.minColumn,
      bounds.minCoord,
      bounds.maxColumn - bounds.minColumn,
      bounds.maxCoord - bounds.minCoord,
    )) {
      return this._linkSpacing;
    }

    const availSpace = positions.maxAvoidsLinksSpaceH(
      bounds.minColumn,
      bounds.maxColumn,
      (bounds.minCoord + bounds.maxCoord) / 2,
      bounds.maxCoord - bounds.minCoord,
    );
    return Math.min(this._linkSpacing, (2 * availSpace) / (1 + bounds.maxLayer));
  }

  private applyGridlineSpacing(
    gridline: _SegInfo[],
    bounds: GridlineAdjustmentBounds,
    realSpacing: number,
  ): void {
    for (let i = 0; i < gridline.length; i++) {
      const seg = gridline[i];
      if (seg.link === null) continue;

      const newcoord = this._coord(seg) + (i - bounds.maxLayer / 2) * realSpacing;
      this.updateSegmentRoutePoints(seg, bounds.vertical, newcoord);
    }
  }

  private updateSegmentRoutePoints(seg: _SegInfo, vertical: boolean, newcoord: number): void {
    const link = seg.link;
    if (link === null) return;

    link.startRoute();
    for (let j = seg.indexStart; j <= seg.indexEnd; j++) {
      const point = link.getPoint(j);
      link.setPoint(j, vertical ? new go.Point(newcoord, point.y) : new go.Point(point.x, newcoord));
    }
    link.commitRoute();
  }

  /** @internal */
  partialSort<T>(arr: T[], start: number, end: number, f: (a: T, b: T) => number): T[] {
    const preSorted = arr.slice(0, start);
    const postSorted = arr.slice(end);
    const sorted = arr.slice(start, end).sort(f);
    arr.length = 0;
    arr.push(...preSorted, ...sorted, ...postSorted);
    return arr;
  }

  /** @internal */
  endpointComparer(seg1: _SegInfo, seg2: _SegInfo): number {
    const range1 = this.getColumnRange(seg1);
    const range2 = this.getColumnRange(seg2);
    return this.compareEndpointRanges({
      relation: this.resolveEndpointRangeRelation(range1, range2),
      geo: seg1.geo,
      startEqual: this.isApprox(range1.start, range2.start),
      endEqual: this.isApprox(range1.end, range2.end),
    });
  }

  private getColumnRange(seg: _SegInfo): ColumnRange {
    return {
      start: Math.min(this._columnStart(seg), this._columnEnd(seg)),
      end: Math.max(this._columnStart(seg), this._columnEnd(seg)),
    };
  }

  private resolveEndpointRangeRelation(range1: ColumnRange, range2: ColumnRange): EndpointRangeRelation {
    if (range2.start <= range1.start && range1.end <= range2.end) return 'secondContainsFirst';
    if (range1.start <= range2.start && range2.end <= range1.end) return 'firstContainsSecond';
    if (range2.start <= range1.start && range2.end <= range1.end) return 'secondStartsBeforeFirst';
    if (range1.start <= range2.start && range1.end <= range2.end) return 'firstStartsBeforeSecond';
    return 'none';
  }

  private compareEndpointRanges(input: EndpointComparison): number {
    switch (input.relation) {
      case 'secondContainsFirst':
        return this.compareWhenSecondContainsFirst(input);
      case 'firstContainsSecond':
        return this.compareWhenFirstContainsSecond(input);
      case 'secondStartsBeforeFirst':
        return this.compareStaggeredEndpoint(input.geo, -1, 1);
      case 'firstStartsBeforeSecond':
        return this.compareStaggeredEndpoint(input.geo, 1, -1);
      default:
        return 0;
    }
  }

  private compareWhenSecondContainsFirst(input: EndpointComparison): number {
    switch (input.geo) {
      case 0:
        return this.compareEqualEndpoint(input, 1, -1);
      case 1:
        return this.compareEqualEndpoint(input, -1, 1);
      case 2:
        return 1;
      case 3:
        return -1;
      default:
        return 0;
    }
  }

  private compareWhenFirstContainsSecond(input: EndpointComparison): number {
    switch (input.geo) {
      case 0:
        return this.compareEqualEndpoint(input, -1, 1);
      case 1:
        return this.compareEqualEndpoint(input, 1, -1);
      case 2:
        return -1;
      case 3:
        return 1;
      default:
        return 0;
    }
  }

  private compareEqualEndpoint(input: EndpointComparison, startResult: number, endResult: number): number {
    if (input.startEqual) return startResult;
    if (input.endEqual) return endResult;
    return 0;
  }

  private compareStaggeredEndpoint(geo: number, geo0Result: number, geo1Result: number): number {
    if (geo === 0) return geo0Result;
    if (geo === 1) return geo1Result;
    return 0;
  }

  /** @internal */
  sortGridline(gridline: _SegInfo[]): void {
    gridline.sort((seg1: _SegInfo, seg2: _SegInfo) => seg2.geo - seg1.geo);

    let numGeo0 = 0;
    let numGeo1 = 0;
    let numGeo2 = 0;
    let numGeo3 = 0;

    for (let i = 0; i < gridline.length; i++) {
      switch (gridline[i].geo) {
        case 0:
          numGeo0++;
          break;
        case 1:
          numGeo1++;
          break;
        case 2:
          numGeo2++;
          break;
        case 3:
          numGeo3++;
          break;
      }
    }

    const n1 = numGeo0;
    const n2 = numGeo0 + numGeo1;
    const n3 = numGeo0 + numGeo1 + numGeo2;
    const n4 = numGeo0 + numGeo1 + numGeo2 + numGeo3;

    if (numGeo0 > 1) {
      this.partialSort(gridline, 0, n1, (seg1, seg2) => this.endpointComparer(seg1, seg2));
    }
    if (numGeo1 > 1) {
      this.partialSort(gridline, n1, n2, (seg1, seg2) => this.endpointComparer(seg1, seg2));
    }
    if (numGeo2 > 1) {
      this.partialSort(gridline, n2, n3, (seg1, seg2) => this.endpointComparer(seg1, seg2));
    }
    if (numGeo3 > 1) {
      this.partialSort(gridline, n3, n4, (seg1, seg2) => this.endpointComparer(seg1, seg2));
    }
  }

  /** @hidden */
  isApprox(a: number, b: number): boolean {
    const d = a - b;
    return d > -0.5 && d < 0.5;
  }
}

/** @internal */
class _SegInfo {
  vertical: boolean;
  indexStart: number;
  indexEnd: number;
  link: go.Link | null;
  geo: number;
  constructor() {
    this.vertical = false;
    this.indexStart = NaN;
    this.indexEnd = NaN;
    this.link = null;
    this.geo = 0;
  }

  _computeGeo(): void {
    if (this.vertical) this._computeGeoV();
    else this._computeGeoH();
  }

  _computeGeoH(): void {
    if (this.link === null) return;
    this.computeGeoForAxes('x', 'y');
  }

  _computeGeoV(): void {
    if (this.link === null) return;
    this.computeGeoForAxes('y', 'x');
  }

  private computeGeoForAxes(columnAxis: SegmentAxis, coordAxis: SegmentAxis): void {
    const link = this.link;
    if (link === null) return;

    const j1 = this.findPreviousAxisBend(columnAxis);
    const j2 = this.findNextAxisBend(columnAxis);
    const value1 = link.getPoint(j1)[coordAxis];
    const value2 = link.getPoint(j2)[coordAxis];
    const coord = link.getPoint(this.indexStart)[coordAxis];
    const columnStart = link.getPoint(this.indexStart)[columnAxis];
    const columnEnd = link.getPoint(this.indexEnd + 1)[columnAxis];

    this.geo = columnStart < columnEnd
      ? this.resolveForwardGeo(value1, value2, coord)
      : this.resolveReverseGeo(value1, value2, coord);
  }

  private findPreviousAxisBend(axis: SegmentAxis): number {
    if (this.link === null) return this.indexStart - 1;

    let j1 = this.indexStart - 1;
    while (j1 > 0 && Math.abs(this.link.getPoint(j1)[axis] - this.link.getPoint(j1 - 1)[axis]) < 0.5) {
      j1--;
    }
    return j1;
  }

  private findNextAxisBend(axis: SegmentAxis): number {
    if (this.link === null) return this.indexEnd + 1;

    let j2 = this.indexEnd + 1;
    while (
      j2 < this.link.pointsCount - 1 &&
      Math.abs(this.link.getPoint(j2)[axis] - this.link.getPoint(j2 + 1)[axis]) < 0.5
    ) {
      j2++;
    }
    return j2;
  }

  private resolveForwardGeo(value1: number, value2: number, coord: number): number {
    if (value1 < coord && value2 > coord) return 0;
    if (value1 > coord && value2 < coord) return 1;
    if (value1 > coord && value2 > coord) return 2;
    if (value1 < coord && value2 < coord) return 3;
    return this.geo;
  }

  private resolveReverseGeo(value1: number, value2: number, coord: number): number {
    if (value2 < coord && value1 > coord) return 0;
    if (value2 > coord && value1 < coord) return 1;
    if (value2 > coord && value1 > coord) return 2;
    if (value2 < coord && value1 < coord) return 3;
    return this.geo;
  }
}
