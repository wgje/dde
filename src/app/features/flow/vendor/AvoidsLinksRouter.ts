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
    let p: go.Point;
    let q: go.Point;
    let found: boolean;
    let i: number;
    let j: number;
    let currentseg: _SegInfo = this._allocSegInfo();
    let enclosingRect: go.Rect | null = null;

    const skipBounds = coll instanceof go.Diagram && links.count === coll.links.count;

    for (const l of links) {
      if (!this.isRoutable(l, coll)) continue;
      if (!skipBounds) {
        if (enclosingRect === null) {
          enclosingRect = l.getDocumentBounds();
        } else {
          enclosingRect.unionRect(l.getDocumentBounds());
        }
      }
      i = this.nextOrthoBend(l, 0);
      while (i < l.pointsCount - 1) {
        j = this.nextOrthoBend(l, i);
        if (j === l.pointsCount - 1) break;
        p = l.getPoint(i);
        q = l.getPoint(j);
        const vertical = this.isApprox(p.x, q.x) && !this.isApprox(p.y, q.y);

        const seginfo = this._allocSegInfo();
        seginfo.indexStart = i;
        seginfo.indexEnd = j;
        seginfo.link = l;
        seginfo.vertical = vertical;
        seginfo._computeGeo();

        found = false;
        for (const line of this._allsegs) {
          if (
            Math.abs(this._coord(line.first()!) - this._coord(seginfo)) < this._epsilonDistance &&
            line.first()!.vertical === vertical
          ) {
            found = true;
            line.add(seginfo);
            break;
          }
        }
        if (!found) {
          this._allsegs.add(new go.List([seginfo]));
        }
        i = j;
      }
    }

    if (coll && enclosingRect !== null && !skipBounds) {
      for (const l of this.diagram!.findPartsIn(enclosingRect, true)) {
        if (!(l instanceof go.Link)) continue;
        if (!l.isOrthogonal) continue;
        if (links.has(l)) continue;
        i = this.nextOrthoBend(l, 0);
        while (i < l.pointsCount - 1) {
          j = this.nextOrthoBend(l, i);
          if (j === l.pointsCount - 1) break;
          p = l.getPoint(i);
          q = l.getPoint(j);
          const vertical = this.isApprox(p.x, q.x) && !this.isApprox(p.y, q.y);
          const coord = vertical ? p.x : p.y;
          for (const line of this._allsegs) {
            if (
              Math.abs(this._coord(line.first()!) - coord) < this._epsilonDistance &&
              line.first()!.vertical === vertical
            ) {
              const seginfo = this._allocSegInfo();
              seginfo.indexStart = i;
              seginfo.indexEnd = j;
              seginfo.link = l;
              seginfo.vertical = vertical;
              seginfo._computeGeo();
              line.add(seginfo);
              break;
            }
          }
          i = j;
        }
      }
    }

    for (const line of this._allsegs) {
      while (line.count > 0) {
        currentseg = line.pop()!;
        const newline = new go.List([currentseg]);
        found = true;
        while (found) {
          found = false;
          for (const otherseg of newline) {
            for (const seginfo of line) {
              const minI = Math.min(this._columnStart(seginfo), this._columnEnd(seginfo));
              const maxI = Math.max(this._columnStart(seginfo), this._columnEnd(seginfo));
              const minJ = Math.min(this._columnStart(otherseg), this._columnEnd(otherseg));
              const maxJ = Math.max(this._columnStart(otherseg), this._columnEnd(otherseg));
              if (minJ <= maxI && minI <= maxJ && seginfo.link !== otherseg.link) {
                line.remove(seginfo);
                newline.push(seginfo);
                found = true;
                break;
              }
            }
          }
        }
        this._gridlines.add(newline);
      }
    }
  }

  /** @internal */
  adjustOverlaps(positions: go.PositionArray | null): void {
    const gridlines = this._gridlines;
    for (const line of gridlines) {
      if (line.count < 2) continue;
      const gridline = line.toArray();
      this.sortGridline(gridline);
      const vertical = gridline[0].vertical;
      const maxlayer = gridline.length - 1;

      let realSpacing = this._linkSpacing;

      if (this._avoidsNodes && maxlayer > 0 && positions) {
        let minColumn = Math.min(this._columnStart(gridline[0]), this._columnEnd(gridline[0]));
        let maxColumn = Math.max(this._columnStart(gridline[0]), this._columnEnd(gridline[0]));
        const minCoord = this._coord(gridline[0]) - (maxlayer * this._linkSpacing) / 2;
        const maxCoord = this._coord(gridline[0]) + (maxlayer * this._linkSpacing) / 2;
        for (let i = 1; i < gridline.length; i++) {
          const seg = gridline[i];
          minColumn = Math.min(minColumn, Math.min(this._columnStart(seg), this._columnEnd(seg)));
          maxColumn = Math.max(maxColumn, Math.max(this._columnStart(seg), this._columnEnd(seg)));
        }

        if (vertical) {
          if (!positions.isUnoccupied(minCoord, minColumn, maxCoord - minCoord, maxColumn - minColumn)) {
            const availSpace = positions.maxAvoidsLinksSpaceV(
              minColumn,
              maxColumn,
              this._coord(gridline[0]),
              maxCoord - minCoord,
            );
            realSpacing = Math.min(this._linkSpacing, (2 * availSpace) / (1 + maxlayer));
          }
        } else {
          if (!positions.isUnoccupied(minColumn, minCoord, maxColumn - minColumn, maxCoord - minCoord)) {
            const availSpace = positions.maxAvoidsLinksSpaceH(
              minColumn,
              maxColumn,
              this._coord(gridline[0]),
              maxCoord - minCoord,
            );
            realSpacing = Math.min(this._linkSpacing, (2 * availSpace) / (1 + maxlayer));
          }
        }
        if (realSpacing === 0) realSpacing = this._linkSpacing;
      }

      for (let i = 0; i < gridline.length; i++) {
        const seg = gridline[i];
        if (seg.link === null) continue;
        const newcoord = this._coord(seg) + (i - maxlayer / 2) * realSpacing;
        seg.link.startRoute();
        for (let j = seg.indexStart; j <= seg.indexEnd; j++) {
          if (vertical) {
            seg.link.setPoint(j, new go.Point(newcoord, seg.link.getPoint(j).y));
          } else {
            seg.link.setPoint(j, new go.Point(seg.link.getPoint(j).x, newcoord));
          }
        }
        seg.link.commitRoute();
      }
    }
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
    const start1 = Math.min(this._columnStart(seg1), this._columnEnd(seg1));
    const end1 = Math.max(this._columnStart(seg1), this._columnEnd(seg1));
    const start2 = Math.min(this._columnStart(seg2), this._columnEnd(seg2));
    const end2 = Math.max(this._columnStart(seg2), this._columnEnd(seg2));

    const startEqual = this.isApprox(start1, start2);
    const endEqual = this.isApprox(end1, end2);

    const geo = seg1.geo;

    let result = 0;

    if (start2 <= start1 && end1 <= end2) {
      if (geo === 0 && startEqual) result = 1;
      else if (geo === 0 && endEqual) result = -1;
      else if (geo === 1 && startEqual) result = -1;
      else if (geo === 1 && endEqual) result = 1;
      else if (geo === 2) result = 1;
      else if (geo === 3) result = -1;
    } else if (start1 <= start2 && end2 <= end1) {
      if (geo === 0 && startEqual) result = -1;
      else if (geo === 0 && endEqual) result = 1;
      else if (geo === 1 && startEqual) result = 1;
      else if (geo === 1 && endEqual) result = -1;
      else if (geo === 2) result = -1;
      else if (geo === 3) result = 1;
    } else if (start2 <= start1 && end2 <= end1) {
      if (geo === 0) result = -1;
      else if (geo === 1) result = 1;
    } else if (start1 <= start2 && end1 <= end2) {
      if (geo === 0) result = 1;
      else if (geo === 1) result = -1;
    }
    return result;
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
    let j1 = this.indexStart - 1;
    let j2 = this.indexEnd + 1;
    while (j1 > 0 && Math.abs(this.link.getPoint(j1).x - this.link.getPoint(j1 - 1).x) < 0.5) j1--;
    while (
      j2 < this.link.pointsCount - 1 &&
      Math.abs(this.link.getPoint(j2).x - this.link.getPoint(j2 + 1).x) < 0.5
    ) {
      j2++;
    }

    const y1 = this.link.getPoint(j1).y;
    const y2 = this.link.getPoint(j2).y;
    const coord = this.link.getPoint(this.indexStart).y;
    const columnStart = this.link.getPoint(this.indexStart).x;
    const columnEnd = this.link.getPoint(this.indexEnd + 1).x;

    if (columnStart < columnEnd) {
      if (y1 < coord && y2 > coord) this.geo = 0;
      else if (y1 > coord && y2 < coord) this.geo = 1;
      else if (y1 > coord && y2 > coord) this.geo = 2;
      else if (y1 < coord && y2 < coord) this.geo = 3;
    } else {
      if (y2 < coord && y1 > coord) this.geo = 0;
      else if (y2 > coord && y1 < coord) this.geo = 1;
      else if (y2 > coord && y1 > coord) this.geo = 2;
      else if (y2 < coord && y1 < coord) this.geo = 3;
    }
  }

  _computeGeoV(): void {
    if (this.link === null) return;
    let j1 = this.indexStart - 1;
    let j2 = this.indexEnd + 1;
    while (j1 > 0 && Math.abs(this.link.getPoint(j1).y - this.link.getPoint(j1 - 1).y) < 0.5) j1--;
    while (
      j2 < this.link.pointsCount - 1 &&
      Math.abs(this.link.getPoint(j2).y - this.link.getPoint(j2 + 1).y) < 0.5
    ) {
      j2++;
    }
    const x1 = this.link.getPoint(j1).x;
    const x2 = this.link.getPoint(j2).x;
    const coord = this.link.getPoint(this.indexStart).x;
    const columnStart = this.link.getPoint(this.indexStart).y;
    const columnEnd = this.link.getPoint(this.indexEnd + 1).y;

    if (columnStart < columnEnd) {
      if (x1 < coord && x2 > coord) this.geo = 0;
      else if (x1 > coord && x2 < coord) this.geo = 1;
      else if (x1 > coord && x2 > coord) this.geo = 2;
      else if (x1 < coord && x2 < coord) this.geo = 3;
    } else {
      if (x2 < coord && x1 > coord) this.geo = 0;
      else if (x2 > coord && x1 < coord) this.geo = 1;
      else if (x2 > coord && x1 > coord) this.geo = 2;
      else if (x2 < coord && x1 < coord) this.geo = 3;
    }
  }
}
