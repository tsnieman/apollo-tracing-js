import { 
    GraphQLSchema,
    GraphQLType,
    getNamedType,
    GraphQLObjectType,
    GraphQLField,
    GraphQLFieldResolver,
    defaultFieldResolver,
    ResponsePath,
    responsePathAsArray
} from 'graphql';

import {
  forEachField,
  addSchemaLevelResolveFunction
} from 'graphql-tools'

export type HighResolutionTime = [number, number]

export class TelemetryCollector {
  startWallTime: Date;
  endWallTime: Date;
  startHrTime: HighResolutionTime;
  duration: HighResolutionTime;

  resolverCalls: ResolverCall[];

  constructor() {
    this.resolverCalls = [];
  }

  executionDidStart() {
    this.startWallTime = new Date();
    this.startHrTime = process.hrtime();
  }

  executionDidEnd() {
    this.duration = process.hrtime(this.startHrTime);
    this.endWallTime = new Date();
  }
}

export interface ResolverCall {
  path: ResponsePath;
  startOffset: HighResolutionTime;
  endOffset?: HighResolutionTime;
}

export function instrumentSchemaForTelemetry(schema: GraphQLSchema) {
  forEachField(schema, instrumentField);

  addSchemaLevelResolveFunction(schema, (source, args, context, info) => {
    const telemetryCollector = new TelemetryCollector();
    context._telemetryCollector = telemetryCollector;
    telemetryCollector.executionDidStart();
    return source;
  });
}

export function telemetryCollectorFromContext(context: any): TelemetryCollector {
  let telemetryCollector = context._telemetryCollector;
  if (!telemetryCollector) {
    throw new Error("Couldn't find '_telemetryCollector' in GraphQL context");
  }
  return telemetryCollector;
}

function instrumentField(field: GraphQLField<any, any>): void {
  const fieldResolver = field.resolve;

  const instrumentedFieldResolver: GraphQLFieldResolver<any, any> = (source, args, context, info) => {
    const telemetryCollector = telemetryCollectorFromContext(context);

    const resolverCall: ResolverCall = {
      path: info.path,
      startOffset: process.hrtime(telemetryCollector.startHrTime)
    };

    function resolverCallDidFinish() {
      resolverCall.endOffset = process.hrtime(telemetryCollector.startHrTime)
    }

    telemetryCollector.resolverCalls.push(resolverCall);

    // If no resolver has been defined for a field, use the default field resolver
    // (which matches the behavior of graphql-js when there is no explicit resolve function defined).
    // TODO: Find a way to respect custom field resolvers, see https://github.com/graphql/graphql-js/pull/865
    try {
      const result = (fieldResolver || defaultFieldResolver)(source, args, context, info);
      whenResultIsFinished(result, resolverCallDidFinish);
      return result;
    } catch (error) {
      resolverCallDidFinish();
      throw error;
    }
  }

  field.resolve = instrumentedFieldResolver;
}

function whenResultIsFinished(result: any, callback: () => void) {
  if (result === null || typeof result === 'undefined') {
    callback();
  } else if (typeof result.then === 'function') {
    result.then(callback, callback);
  } else if (Array.isArray(result)) {
    const promises: Promise<any>[] = [];
    result.forEach(value => {
      if (value && typeof value.then === 'function') {
        promises.push(value);
      }
      if (promises.length > 0) {
        Promise.all(promises).then(callback, callback);
      } else {
        callback();
      }
    });
  } else {
    callback();
  }
}
