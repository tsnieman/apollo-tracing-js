import {
  GraphQLType,
  ResponsePath,
  responsePathAsArray
} from 'graphql';

import * as base64 from './base64';

import { 
  TelemetryCollector,
  ResolverCall,
  HighResolutionTime
} from './instrumentation';

export interface TelemetryData {
  version: 1,
  startTime: string,
  endTime: string,
  duration: number,
  execution: {
    resolvers: CompactResolverCalls
  }
}

export interface CompactResolverCalls {
  types: [string, string[]]
  templates: [number[]]
  compactNodes: string
}

export function formatTelemetryData(telemetryCollector: TelemetryCollector): TelemetryData {
  return {
    "version": 1,
    "startTime": telemetryCollector.startWallTime.toISOString(),
    "endTime": telemetryCollector.endWallTime.toISOString(),
    "duration": durationHrTimeToNanos(telemetryCollector.duration),
    "execution": {
      resolvers: encodeCompactResolverCalls(telemetryCollector.resolverCalls)
    }
  }
}

export function formatResolverCalls(resolverCalls: ResolverCall[]) {
  return resolverCalls.map(resolverCall => {
    return {
      path: responsePathAsArray(resolverCall.path),
      parentType: resolverCall.parentType.toString(),
      fieldName: resolverCall.fieldName,
      returnType: resolverCall.returnType.toString(),
      startOffset: durationHrTimeToNanos(resolverCall.startOffset),
      endOffset: durationHrTimeToNanos(resolverCall.endOffset),
    }
  });
}

type Node = LeafNode | ObjectNode | ListNode;

interface LeafNode {
  kind: 'Leaf';
  key: string | number;
  resolverCall?: ResolverCall;
}

interface ObjectNode {
  kind: 'Object';
  key: string | number;
  resolverCall?: ResolverCall;
  children: { [key: string]: Node };
}

interface ListNode {
  kind: 'List';
  key: string | number;
  resolverCall?: ResolverCall;
  children: Node[];
}

export function encodeCompactResolverCalls(resolverCalls: ResolverCall[]): CompactResolverCalls {
  let root: Node = { kind: 'Object', key: '', children: {} };

  resolverCalls.forEach(resolverCall => {
    const path = resolverCall.path;
    if (!path) return;

    const node = responsePathAsArray(path)
      .reduce(
        (parent, key) => {
          if (parent.kind === 'Leaf') {
            if (typeof key === 'number') {
              parent.kind = 'List'
              parent.children = [];
            } else {
              parent.kind = 'Object'
              parent.children = {};
            }
          }

          let children = parent.children;
          let child = children[key];

          if (!child) {
            child = { kind: 'Leaf', key: key };
            children[key] = child;
          }

          return child;
        },
        root
      );

    node.resolverCall = resolverCall;
  });

  const writer = new CompactResolverCallsWriter();
  writer.writeNode(root);
  return writer.compactResolverCalls;
}

export function decodeCompactResolverCalls(compactResolverCalls: CompactResolverCalls): ResolverCall[] {
  const reader = new CompactResolverCallsReader(compactResolverCalls);
  reader.decodeNode();
  return reader.resolverCalls;
}

// Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
//
// ONLY CALL THIS ON VALUES REPRESENTING DELTAS, NOT ON THE RAW RETURN VALUE
// FROM process.hrtime() WITH NO ARGUMENTS.
//
// The entire point of the hrtime data structure is that the JavaScript Number
// type can't represent all int64 values without loss of precision:
// Number.MAX_SAFE_INTEGER nanoseconds is about 104 days. Calling this function
// on a duration that represents a value less than 104 days is fine. Calling
// this function on an absolute time (which is generally roughly time since
// system boot) is not a good idea.
function durationHrTimeToNanos(hrtime: HighResolutionTime) {
  return (hrtime[0] * 1e9) + hrtime[1];
}

const VLQ_BASE_SHIFT = 5;

// binary: 100000
const VLQ_BASE = 1 << VLQ_BASE_SHIFT;

// binary: 011111
const VLQ_BASE_MASK = VLQ_BASE - 1;

// binary: 100000
const VLQ_CONTINUATION_BIT = VLQ_BASE;

type TypeDescriptor = [GraphQLType, FieldDescriptor[]];

class FieldDescriptor {
  fieldName: string;
  returnType: GraphQLType;

  constructor(fieldName: string, returnType: GraphQLType) {
    this.fieldName = fieldName;
    this.returnType = returnType;
  }

  toJSON() {
    return [this.fieldName, this.returnType.toString()];
  }
}

class CompactResolverCallsWriter {
  types: [TypeDescriptor] = [];
  templates: Template[] = [];
  compactNodes: string = '';

  get compactResolverCalls(): CompactResolverCalls {
    return { types: this.types, templates: this.templates, compactNodes: this.compactNodes }
  }

  writeNode(node: Node) {
    const resolverCall = node.resolverCall;
    if (resolverCall) {
      this.writeTiming(resolverCall);
    } else {
      this.writeString(',');
    }

    switch (node.kind) {
      case 'Object':
        this.writeString('(');
        const fields = Object.values(node.children); 
        this.writeInt(this.templateIndexForChildren(fields));
        fields.forEach(this.writeNode, this);
        break;
      case 'List':
        this.writeString('[');
        this.writeInt(node.children.length);
        node.children.forEach(this.writeNode, this);
        break;
    }
  }

  writeString(value: string) {
    this.compactNodes += value;
  }

  writeTiming({ startOffset, endOffset }: { startOffset: HighResolutionTime, endOffset: HighResolutionTime }) {
    this.writeInt(durationHrTimeToNanos(startOffset));
    this.writeInt(durationHrTimeToNanos(endOffset));
  }

  writeInt(value: number) {
    let digit: number;
    do {
      digit = value & VLQ_BASE_MASK;
      value = value >>> VLQ_BASE_SHIFT;
      if (value > 0) {
        digit = digit | VLQ_CONTINUATION_BIT;
      }
      this.compactNodes += base64.encode(digit);
    } while (value > 0);
  }

  private templateIndexForChildren(children: Node[]) {    
    const parentType = children[0].resolverCall.parentType;

    let typeIndex = this.types.findIndex(type => {
      return type[0] === parentType;
    })

    let type: TypeDescriptor;
    if (typeIndex === -1) {
      typeIndex = this.types.length;
      type = [parentType, []];
      this.types.push(type);
    } else {
      type = this.types[typeIndex];
    }

    let [,fields] = type;

    const fieldIndexes = children.map(child => {
      const { fieldName, returnType } = child.resolverCall;

      let fieldIndex = fields.findIndex(field => {
        return field.fieldName === fieldName;
      })

      if (fieldIndex === -1) {
        fieldIndex = fields.length;
        fields.push(new FieldDescriptor(fieldName, returnType));
      }

      return fieldIndex;
    })

    const template = [typeIndex, ...fieldIndexes];

    let templateIndex = this.templates.findIndex(existingTemplate => {
      return template.toString() === existingTemplate.toString();
    });

    if (templateIndex === -1) {
      templateIndex = this.templates.length;
      this.templates.push(template);
    }

    return templateIndex;
  }
}

class CompactResolverCallsReader {
  types: [string, string[]];
  templates: [number[]];
  compactNodes: string;

  resolverCalls: {
    path: (string | number)[];
    fieldName: string,
    parentType: string,
    returnType: string,
    startOffset: number;
    endOffset: number;
  }[] = [];

  position: number = 0;
  
  path: ResponsePath;

  currentField: {
    parentType: string;
    fieldName: string;
    returnType: string;
  };

  constructor({ types, templates, compactNodes }: CompactResolverCalls) {
    this.types = types;
    this.templates = templates;
    this.compactNodes = compactNodes;
  }

  decodeNode() {
    if (this.peek() === ',') {
      this.skip();
    } else {
      this.decodeTimings();
    }

    switch (this.peek()) {
      case '(':
        this.skip();
        this.decodeObject();
        break;
      case '[':
        this.skip();
        this.decodeArray();
        break;
    }
  }

  decodeObject() {
    const templateIndex = this.readInt();

    const template = this.templates[templateIndex];
    const [parentTypeIndex, ...fieldIndexes] = template;

    const parentTypeDescriptor = this.types[parentTypeIndex];
    const [parentType, fieldDescriptors] = parentTypeDescriptor;
    const fields = fieldIndexes.map(index => fieldDescriptors[index]);

    for (const [fieldName, returnType] of fields) {
      this.currentField = { 
        parentType,
        fieldName,
        returnType
      };

      this.appendPathComponent(fieldName);

      this.decodeNode();

      this.removeLastPathComponent();
    }
  }

  decodeArray() {
    const length = this.readInt();

    for (let i = 0; i < length; i++) {
      this.appendPathComponent(i);

      this.decodeNode();

      this.removeLastPathComponent();
    }
  }

  decodeTimings() {
    const startOffset = this.readInt();
    const endOffset = this.readInt();

    this.resolverCalls.push({
      path: responsePathAsArray(this.path),
      ...this.currentField,
      startOffset,
      endOffset
    });
  }

  appendPathComponent(key: string | number) {
    this.path = { prev: this.path, key };
  }

  removeLastPathComponent() {
    this.path = this.path && this.path.prev;
  }

  peek(): string {
    return this.compactNodes.charAt(this.position);
  }

  skip() {
    this.position++;
  }

  readCharCode(): number {
    return this.compactNodes.charCodeAt(this.position++);
  }

  readInt(): number {
    let value = 0;

    let shift = 0;
    let digit;
    let continues;

    do {
      const charCode = this.readCharCode();
      digit = base64.decode(charCode);

      if (digit == -1) {
        throw new Error(`Invalid base64 char code: '${charCode}'`);
      }

      continues = !!(digit & VLQ_CONTINUATION_BIT);
      digit &= VLQ_BASE_MASK;
      value += (digit << shift);
      shift += VLQ_BASE_SHIFT;
    } while (continues);

    return value;
  }
}