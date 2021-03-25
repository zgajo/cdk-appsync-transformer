"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppSyncTransformer = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_appsync_1 = require("@aws-cdk/aws-appsync");
const aws_dynamodb_1 = require("@aws-cdk/aws-dynamodb");
const aws_iam_1 = require("@aws-cdk/aws-iam");
const core_1 = require("@aws-cdk/core");
const schema_transformer_1 = require("./transformer/schema-transformer");
const defaultAuthorizationConfig = {
  defaultAuthorization: {
    authorizationType: aws_appsync_1.AuthorizationType.API_KEY,
    apiKeyConfig: {
      description: "Auto generated API Key from construct",
      name: "dev",
    },
  },
};
/**
 * (experimental) AppSyncTransformer Construct.
 *
 * @experimental
 */
class AppSyncTransformer extends core_1.Construct {
  /**
   * @experimental
   */
  constructor(scope, id, props) {
    var _b, _c, _d, _e, _f, _g, _h;
    super(scope, id);
    this.streamPerTable = props.streamPerTable || [];

    this.isSyncEnabled = props.syncEnabled ? props.syncEnabled : false;
    const transformerConfiguration = {
      schemaPath: props.schemaPath,
      syncEnabled:
        (_b = props.syncEnabled) !== null && _b !== void 0 ? _b : false,
    };
    // Combine the arrays so we only loop once
    // Test each transformer to see if it implements ITransformer
    const allCustomTransformers = [
      ...((_c = props.preCdkTransformers) !== null && _c !== void 0 ? _c : []),
      ...((_d = props.postCdkTransformers) !== null && _d !== void 0 ? _d : []),
    ];
    if (allCustomTransformers && allCustomTransformers.length > 0) {
      allCustomTransformers.forEach((transformer) => {
        if (transformer && !this.implementsITransformer(transformer)) {
          throw new Error(
            `Transformer does not implement ITransformer from graphql-transformer-core: ${transformer}`
          );
        }
      });
    }
    const transformer = new schema_transformer_1.SchemaTransformer(
      transformerConfiguration
    );
    this.outputs = transformer.transform(
      props.preCdkTransformers,
      props.postCdkTransformers
    );
    const resolvers = transformer.getResolvers();
    this.functionResolvers =
      (_e = this.outputs.functionResolvers) !== null && _e !== void 0 ? _e : {};
    // Remove any function resolvers from the total list of resolvers
    // Otherwise it will add them twice
    for (const [_, functionResolvers] of Object.entries(
      this.functionResolvers
    )) {
      functionResolvers.forEach((resolver) => {
        switch (resolver.typeName) {
          case "Query":
          case "Mutation":
          case "Subscription":
            delete resolvers[resolver.fieldName];
            break;
        }
      });
    }
    this.httpResolvers =
      (_f = this.outputs.httpResolvers) !== null && _f !== void 0 ? _f : {};
    // Remove any http resolvers from the total list of resolvers
    // Otherwise it will add them twice
    for (const [_, httpResolvers] of Object.entries(this.httpResolvers)) {
      httpResolvers.forEach((resolver) => {
        switch (resolver.typeName) {
          case "Query":
          case "Mutation":
          case "Subscription":
            delete resolvers[resolver.fieldName];
            break;
        }
      });
    }
    this.resolvers = resolvers;
    this.nestedAppsyncStack = new core_1.NestedStack(
      this,
      "appsync-nested-stack"
    );
    // AppSync
    this.appsyncAPI = new aws_appsync_1.GraphqlApi(
      this.nestedAppsyncStack,
      `${id}-api`,
      {
        name: props.apiName ? props.apiName : `${id}-api`,
        authorizationConfig: props.authorizationConfig
          ? props.authorizationConfig
          : defaultAuthorizationConfig,
        logConfig: {
          fieldLogLevel: props.fieldLogLevel
            ? props.fieldLogLevel
            : aws_appsync_1.FieldLogLevel.NONE,
        },
        schema: aws_appsync_1.Schema.fromAsset("./appsync/schema.graphql"),
        xrayEnabled:
          (_g = props.xrayEnabled) !== null && _g !== void 0 ? _g : false,
      }
    );

    let tableData =
      (_h = this.outputs.cdkTables) !== null && _h !== void 0 ? _h : {};

    // Check to see if sync is enabled
    if (tableData.DataStore) {
      this.isSyncEnabled = true;
      this.syncTable = this.createSyncTable(tableData.DataStore);
      delete tableData.DataStore; // We don't want to create this again below so remove it from the tableData map
    }
    this.tableMap = {};
    this.tableNameMap = this.createTablesAndResolvers(tableData, resolvers);
    if (this.outputs.noneResolvers) {
      this.createNoneDataSourceAndResolvers(
        this.outputs.noneResolvers,
        resolvers
      );
    }
    this.createHttpResolvers();

    // Outputs so we can generate exports
    new core_1.CfnOutput(scope, "appsyncGraphQLEndpointOutput", {
      value: this.appsyncAPI.graphqlUrl,
      description: "Output for aws_appsync_graphqlEndpoint",
    });
  }
  /**
   * graphql-transformer-core needs to be jsii enabled to pull the ITransformer interface correctly.
   * Since it's not in peer dependencies it doesn't show up in the jsii deps list.
   * Since it's not jsii enabled it has to be bundled.
   * The package can't be in BOTH peer and bundled dependencies
   * So we do a fake test to make sure it implements these and hope for the best
   * @param transformer
   */
  implementsITransformer(transformer) {
    return (
      "name" in transformer &&
      "directive" in transformer &&
      "typeDefinitions" in transformer
    );
  }
  /**
   * Creates NONE data source and associated resolvers
   * @param noneResolvers The resolvers that belong to the none data source
   * @param resolvers The resolver map minus function resolvers
   */
  createNoneDataSourceAndResolvers(noneResolvers, resolvers) {
    const noneDataSource = this.appsyncAPI.addNoneDataSource("NONE");
    Object.keys(noneResolvers).forEach((resolverKey) => {
      const resolver = resolvers[resolverKey];
      new aws_appsync_1.Resolver(
        this.nestedAppsyncStack,
        `${resolver.typeName}-${resolver.fieldName}-resolver`,
        {
          api: this.appsyncAPI,
          typeName: resolver.typeName,
          fieldName: resolver.fieldName,
          dataSource: noneDataSource,
          requestMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(
            resolver.requestMappingTemplate
          ),
          responseMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(
            resolver.responseMappingTemplate
          ),
        }
      );
    });
  }
  /**
   * Creates each dynamodb table, gsis, dynamodb datasource, and associated resolvers
   * If sync is enabled then TTL configuration is added
   * Returns tableName: table map in case it is needed for lambda functions, etc
   * @param tableData The CdkTransformer table information
   * @param resolvers The resolver map minus function resolvers
   */
  createTablesAndResolvers(tableData, resolvers) {
    const tableNameMap = {};
    Object.keys(tableData).forEach((tableKey) => {
      const table = this.createTable(tableData[tableKey]);
      const dataSource = this.appsyncAPI.addDynamoDbDataSource(tableKey, table);
      // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-appsync-datasource-deltasyncconfig.html
      if (this.isSyncEnabled && this.syncTable) {
        //@ts-ignore - ds is the base CfnDataSource and the db config needs to be versioned - see CfnDataSource
        dataSource.ds.dynamoDbConfig.versioned = true;
        //@ts-ignore - ds is the base CfnDataSource - see CfnDataSource
        dataSource.ds.dynamoDbConfig.deltaSyncConfig = {
          baseTableTtl: "43200",
          deltaSyncTableName: this.syncTable.tableName,
          deltaSyncTableTtl: "30",
        };
        // Need to add permission for our datasource service role to access the sync table
        dataSource.grantPrincipal.addToPolicy(
          new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ["dynamodb:*"],
            resources: [this.syncTable.tableArn],
          })
        );
      }
      const dynamoDbConfig = dataSource.ds.dynamoDbConfig;
      tableNameMap[tableKey] = dynamoDbConfig.tableName;
      this.tableMap[tableKey] = table;

      // Loop the basic resolvers
      tableData[tableKey].resolvers.forEach((resolverKey) => {
        let resolver = resolvers[resolverKey];
        new aws_appsync_1.Resolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: dataSource,
            requestMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(
              resolver.requestMappingTemplate
            ),
            responseMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(
              resolver.responseMappingTemplate
            ),
          }
        );
      });
      // Loop the gsi resolvers
      tableData[tableKey].gsiResolvers.forEach((resolverKey) => {
        let resolver = resolvers.gsi[resolverKey];
        new aws_appsync_1.Resolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: dataSource,
            requestMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(
              resolver.requestMappingTemplate
            ),
            responseMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(
              resolver.responseMappingTemplate
            ),
          }
        );
      });
    });
    return tableNameMap;
  }
  createTable(tableData) {
    const streamFound = this.streamPerTable.find(
      (obj) => `${obj.table}Table` === tableData.tableName
    );

    let tableProps = {
      billingMode: aws_dynamodb_1.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: tableData.partitionKey.name,
        type: this.convertAttributeType(tableData.partitionKey.type),
      },
      ...(streamFound ? { stream: streamFound.stream } : null),
    };
    if (tableData.sortKey && tableData.sortKey.name) {
      tableProps.sortKey = {
        name: tableData.sortKey.name,
        type: this.convertAttributeType(tableData.sortKey.type),
      };
    }
    if (tableData.ttl && tableData.ttl.enabled) {
      tableProps.timeToLiveAttribute = tableData.ttl.attributeName;
    }
    const table = new aws_dynamodb_1.Table(
      this.nestedAppsyncStack,
      tableData.tableName,
      tableProps
    );
    if (
      tableData.globalSecondaryIndexes &&
      tableData.globalSecondaryIndexes.length > 0
    ) {
      tableData.globalSecondaryIndexes.forEach((gsi) => {
        table.addGlobalSecondaryIndex({
          indexName: gsi.indexName,
          partitionKey: {
            name: gsi.partitionKey.name,
            type: this.convertAttributeType(gsi.partitionKey.type),
          },
          projectionType: this.convertProjectionType(
            gsi.projection.ProjectionType
          ),
        });
      });
    }
    return table;
  }
  /**
   * Creates the sync table for Amplify DataStore
   * https://docs.aws.amazon.com/appsync/latest/devguide/conflict-detection-and-sync.html
   * @param tableData The CdkTransformer table information
   */
  createSyncTable(tableData) {
    var _b;
    return new aws_dynamodb_1.Table(this, "appsync-api-sync-table", {
      billingMode: aws_dynamodb_1.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: tableData.partitionKey.name,
        type: this.convertAttributeType(tableData.partitionKey.type),
      },
      sortKey: {
        name: tableData.sortKey.name,
        type: this.convertAttributeType(tableData.sortKey.type),
      },
      timeToLiveAttribute:
        ((_b = tableData.ttl) === null || _b === void 0
          ? void 0
          : _b.attributeName) || "_ttl",
    });
  }
  convertAttributeType(type) {
    switch (type) {
      case "N":
        return aws_dynamodb_1.AttributeType.NUMBER;
      case "B":
        return aws_dynamodb_1.AttributeType.BINARY;
      case "S": // Same as default
      default:
        return aws_dynamodb_1.AttributeType.STRING;
    }
  }
  convertProjectionType(type) {
    switch (type) {
      case "INCLUDE":
        return aws_dynamodb_1.ProjectionType.INCLUDE;
      case "KEYS_ONLY":
        return aws_dynamodb_1.ProjectionType.KEYS_ONLY;
      case "ALL": // Same as default
      default:
        return aws_dynamodb_1.ProjectionType.ALL;
    }
  }
  createHttpResolvers() {
    for (const [endpoint, httpResolvers] of Object.entries(
      this.httpResolvers
    )) {
      const strippedEndpoint = endpoint.replace(/[^_0-9A-Za-z]/g, "");
      const httpDataSource = this.appsyncAPI.addHttpDataSource(
        `${strippedEndpoint}`,
        endpoint
      );
      httpResolvers.forEach((resolver) => {
        new aws_appsync_1.Resolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: httpDataSource,
            requestMappingTemplate: aws_appsync_1.MappingTemplate.fromString(
              resolver.defaultRequestMappingTemplate
            ),
            responseMappingTemplate: aws_appsync_1.MappingTemplate.fromString(
              resolver.defaultResponseMappingTemplate
            ),
          }
        );
      });
    }
  }
  /**
   * (experimental) Adds the function as a lambdaDataSource to the AppSync api Adds all of the functions resolvers to the AppSync api.
   *
   * @param functionName The function name specified in the.
   * @param id The id to give.
   * @param lambdaFunction The lambda function to attach.
   * @experimental
   * @function directive of the schema
   */
  addLambdaDataSourceAndResolvers(functionName, id, lambdaFunction, options) {
    const functionDataSource = this.appsyncAPI.addLambdaDataSource(
      id,
      lambdaFunction,
      options
    );
    for (const resolver of this.functionResolvers[functionName]) {
      new aws_appsync_1.Resolver(
        this.nestedAppsyncStack,
        `${resolver.typeName}-${resolver.fieldName}-resolver`,
        {
          api: this.appsyncAPI,
          typeName: resolver.typeName,
          fieldName: resolver.fieldName,
          dataSource: functionDataSource,
          requestMappingTemplate: aws_appsync_1.MappingTemplate.fromString(
            resolver.defaultRequestMappingTemplate
          ),
          responseMappingTemplate: aws_appsync_1.MappingTemplate.fromString(
            resolver.defaultResponseMappingTemplate
          ),
        }
      );
    }
    return functionDataSource;
  }
}
exports.AppSyncTransformer = AppSyncTransformer;
_a = JSII_RTTI_SYMBOL_1;
AppSyncTransformer[_a] = {
  fqn: "cdk-appsync-transformer.AppSyncTransformer",
  version: "1.77.9",
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwc3luYy10cmFuc2Zvcm1lci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9hcHBzeW5jLXRyYW5zZm9ybWVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsc0RBVzhCO0FBRTlCLHdEQUsrQjtBQUMvQiw4Q0FBMkQ7QUFFM0Qsd0NBQWtFO0FBVWxFLHlFQUcwQztBQTBEMUMsTUFBTSwwQkFBMEIsR0FBd0I7SUFDdEQsb0JBQW9CLEVBQUU7UUFDcEIsaUJBQWlCLEVBQUUsK0JBQWlCLENBQUMsT0FBTztRQUM1QyxZQUFZLEVBQUU7WUFDWixXQUFXLEVBQUUsdUNBQXVDO1lBQ3BELElBQUksRUFBRSxLQUFLO1NBQ1o7S0FDRjtDQUNGLENBQUM7Ozs7OztBQUtGLE1BQWEsa0JBQW1CLFNBQVEsZ0JBQVM7Ozs7SUF5Qy9DLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7O1FBQ3RFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7UUFFbkUsTUFBTSx3QkFBd0IsR0FBMkI7WUFDdkQsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1lBQzVCLFdBQVcsUUFBRSxLQUFLLENBQUMsV0FBVyxtQ0FBSSxLQUFLO1NBQ3hDLENBQUM7UUFFRiwwQ0FBMEM7UUFDMUMsNkRBQTZEO1FBQzdELE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxTQUFHLEtBQUssQ0FBQyxrQkFBa0IsbUNBQUksRUFBRSxFQUFFLFNBQUcsS0FBSyxDQUFDLG1CQUFtQixtQ0FBSSxFQUFFLENBQUMsQ0FBQztRQUN0RyxJQUFJLHFCQUFxQixJQUFJLHFCQUFxQixDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7WUFDN0QscUJBQXFCLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FB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QyxZQUFZLENBQUMsRUFBRTtZQUMzRCxJQUFJLHNCQUFRLENBQ1YsSUFBSSxDQUFDLGtCQUFrQixFQUN2QixHQUFHLFFBQVEsQ0FBQyxRQUFRLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVyxFQUNyRDtnQkFDRSxHQUFHLEVBQUUsSUFBSSxDQUFDLFVBQVU7Z0JBQ3BCLFFBQVEsRUFBRSxRQUFRLENBQUMsUUFBUTtnQkFDM0IsU0FBUyxFQUFFLFFBQVEsQ0FBQyxTQUFTO2dCQUM3QixVQUFVLEVBQUUsa0JBQWtCO2dCQUM5QixzQkFBc0IsRUFBRSw2QkFBZSxDQUFDLFVBQVUsQ0FDaEQsUUFBUSxDQUFDLDZCQUE2QixDQUN2QztnQkFDRCx1QkFBdUIsRUFBRSw2QkFBZSxDQUFDLFVBQVUsQ0FDakQsUUFBUSxDQUFDLDhCQUE4QixDQUN4QzthQUNGLENBQ0YsQ0FBQztTQUNIO1FBRUQsT0FBTyxrQkFBa0IsQ0FBQztJQUM1QixDQUFDOztBQTViSCxnREE2YkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBHcmFwaHFsQXBpLFxuICBBdXRob3JpemF0aW9uVHlwZSxcbiAgRmllbGRMb2dMZXZlbCxcbiAgTWFwcGluZ1RlbXBsYXRlLFxuICBDZm5EYXRhU291cmNlLFxuICBSZXNvbHZlcixcbiAgQXV0aG9yaXphdGlvbkNvbmZpZyxcbiAgU2NoZW1hLFxuICBEYXRhU291cmNlT3B0aW9ucyxcbiAgTGFtYmRhRGF0YVNvdXJjZSxcbn0gZnJvbSAnQGF3cy1jZGsvYXdzLWFwcHN5bmMnO1xuXG5pbXBvcnQge1xuICBUYWJsZSxcbiAgQXR0cmlidXRlVHlwZSxcbiAgUHJvamVjdGlvblR5cGUsXG4gIEJpbGxpbmdNb2RlLFxufSBmcm9tICdAYXdzLWNkay9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgRWZmZWN0LCBQb2xpY3lTdGF0ZW1lbnQgfSBmcm9tICdAYXdzLWNkay9hd3MtaWFtJztcbmltcG9ydCB7IElGdW5jdGlvbiB9IGZyb20gJ0Bhd3MtY2RrL2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgQ29uc3RydWN0LCBOZXN0ZWRTdGFjaywgQ2ZuT3V0cHV0IH0gZnJvbSAnQGF3cy1jZGsvY29yZSc7XG5cbmltcG9ydCB7XG4gIENka1RyYW5zZm9ybWVyUmVzb2x2ZXIsXG4gIENka1RyYW5zZm9ybWVyRnVuY3Rpb25SZXNvbHZlcixcbiAgQ2RrVHJhbnNmb3JtZXJIdHRwUmVzb2x2ZXIsXG4gIENka1RyYW5zZm9ybWVyVGFibGUsXG4gIFNjaGVtYVRyYW5zZm9ybWVyT3V0cHV0cyxcbn0gZnJvbSAnLi90cmFuc2Zvcm1lcic7XG5cbmltcG9ydCB7XG4gIFNjaGVtYVRyYW5zZm9ybWVyLFxuICBTY2hlbWFUcmFuc2Zvcm1lclByb3BzLFxufSBmcm9tICcuL3RyYW5zZm9ybWVyL3NjaGVtYS10cmFuc2Zvcm1lcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU3luY1RyYW5zZm9ybWVyUHJvcHMge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICByZWFkb25seSBzY2hlbWFQYXRoOiBzdHJpbmc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvbkNvbmZpZz86IEF1dGhvcml6YXRpb25Db25maWc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gIHJlYWRvbmx5IHN5bmNFbmFibGVkPzogYm9vbGVhbjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgcmVhZG9ubHkgZmllbGRMb2dMZXZlbD86IEZpZWxkTG9nTGV2ZWw7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgcmVhZG9ubHkgeHJheUVuYWJsZWQ/OiBib29sZWFuO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgcmVhZG9ubHkgcHJlQ2RrVHJhbnNmb3JtZXJzPzogYW55W107XG5cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgcmVhZG9ubHkgcG9zdENka1RyYW5zZm9ybWVycz86IGFueVtdO1xufVxuXG5jb25zdCBkZWZhdWx0QXV0aG9yaXphdGlvbkNvbmZpZzogQXV0aG9yaXphdGlvbkNvbmZpZyA9IHtcbiAgZGVmYXVsdEF1dGhvcml6YXRpb246IHtcbiAgICBhdXRob3JpemF0aW9uVHlwZTogQXV0aG9yaXphdGlvblR5cGUuQVBJX0tFWSxcbiAgICBhcGlLZXlDb25maWc6IHtcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXV0byBnZW5lcmF0ZWQgQVBJIEtleSBmcm9tIGNvbnN0cnVjdCcsXG4gICAgICBuYW1lOiAnZGV2JyxcbiAgICB9LFxuICB9LFxufTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5leHBvcnQgY2xhc3MgQXBwU3luY1RyYW5zZm9ybWVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICBwdWJsaWMgcmVhZG9ubHkgYXBwc3luY0FQSTogR3JhcGhxbEFwaTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgcHVibGljIHJlYWRvbmx5IG5lc3RlZEFwcHN5bmNTdGFjazogTmVzdGVkU3RhY2s7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlTmFtZU1hcDogeyBbbmFtZTogc3RyaW5nXTogYW55IH07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgcHVibGljIHJlYWRvbmx5IG91dHB1dHM6IFNjaGVtYVRyYW5zZm9ybWVyT3V0cHV0cztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICBwdWJsaWMgcmVhZG9ubHkgcmVzb2x2ZXJzOiBhbnk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICBwdWJsaWMgcmVhZG9ubHkgZnVuY3Rpb25SZXNvbHZlcnM6IHtcbiAgICBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJGdW5jdGlvblJlc29sdmVyW107XG4gIH07XG5cbiAgcHVibGljIHJlYWRvbmx5IGh0dHBSZXNvbHZlcnM6IHtcbiAgICBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJIdHRwUmVzb2x2ZXJbXTtcbiAgfTtcblxuICBwcml2YXRlIGlzU3luY0VuYWJsZWQ6IGJvb2xlYW47XG4gIHByaXZhdGUgc3luY1RhYmxlOiBUYWJsZSB8IHVuZGVmaW5lZDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwU3luY1RyYW5zZm9ybWVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5pc1N5bmNFbmFibGVkID0gcHJvcHMuc3luY0VuYWJsZWQgPyBwcm9wcy5zeW5jRW5hYmxlZCA6IGZhbHNlO1xuXG4gICAgY29uc3QgdHJhbnNmb3JtZXJDb25maWd1cmF0aW9uOiBTY2hlbWFUcmFuc2Zvcm1lclByb3BzID0ge1xuICAgICAgc2NoZW1hUGF0aDogcHJvcHMuc2NoZW1hUGF0aCxcbiAgICAgIHN5bmNFbmFibGVkOiBwcm9wcy5zeW5jRW5hYmxlZCA/PyBmYWxzZSxcbiAgICB9O1xuXG4gICAgLy8gQ29tYmluZSB0aGUgYXJyYXlzIHNvIHdlIG9ubHkgbG9vcCBvbmNlXG4gICAgLy8gVGVzdCBlYWNoIHRyYW5zZm9ybWVyIHRvIHNlZSBpZiBpdCBpbXBsZW1lbnRzIElUcmFuc2Zvcm1lclxuICAgIGNvbnN0IGFsbEN1c3RvbVRyYW5zZm9ybWVycyA9IFsuLi5wcm9wcy5wcmVDZGtUcmFuc2Zvcm1lcnMgPz8gW10sIC4uLnByb3BzLnBvc3RDZGtUcmFuc2Zvcm1lcnMgPz8gW11dO1xuICAgIGlmIChhbGxDdXN0b21UcmFuc2Zvcm1lcnMgJiYgYWxsQ3VzdG9tVHJhbnNmb3JtZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIGFsbEN1c3RvbVRyYW5zZm9ybWVycy5mb3JFYWNoKHRyYW5zZm9ybWVyID0+IHtcbiAgICAgICAgaWYgKHRyYW5zZm9ybWVyICYmICF0aGlzLmltcGxlbWVudHNJVHJhbnNmb3JtZXIodHJhbnNmb3JtZXIpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUcmFuc2Zvcm1lciBkb2VzIG5vdCBpbXBsZW1lbnQgSVRyYW5zZm9ybWVyIGZyb20gZ3JhcGhxbC10cmFuc2Zvcm1lci1jb3JlOiAke3RyYW5zZm9ybWVyfWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmFuc2Zvcm1lciA9IG5ldyBTY2hlbWFUcmFuc2Zvcm1lcih0cmFuc2Zvcm1lckNvbmZpZ3VyYXRpb24pO1xuICAgIHRoaXMub3V0cHV0cyA9IHRyYW5zZm9ybWVyLnRyYW5zZm9ybShwcm9wcy5wcmVDZGtUcmFuc2Zvcm1lcnMsIHByb3BzLnBvc3RDZGtUcmFuc2Zvcm1lcnMpO1xuICAgIGNvbnN0IHJlc29sdmVycyA9IHRyYW5zZm9ybWVyLmdldFJlc29sdmVycygpO1xuXG4gICAgdGhpcy5mdW5jdGlvblJlc29sdmVycyA9IHRoaXMub3V0cHV0cy5mdW5jdGlvblJlc29sdmVycyA/PyB7fTtcblxuICAgIC8vIFJlbW92ZSBhbnkgZnVuY3Rpb24gcmVzb2x2ZXJzIGZyb20gdGhlIHRvdGFsIGxpc3Qgb2YgcmVzb2x2ZXJzXG4gICAgLy8gT3RoZXJ3aXNlIGl0IHdpbGwgYWRkIHRoZW0gdHdpY2VcbiAgICBmb3IgKGNvbnN0IFtfLCBmdW5jdGlvblJlc29sdmVyc10gb2YgT2JqZWN0LmVudHJpZXMoXG4gICAgICB0aGlzLmZ1bmN0aW9uUmVzb2x2ZXJzLFxuICAgICkpIHtcbiAgICAgIGZ1bmN0aW9uUmVzb2x2ZXJzLmZvckVhY2goKHJlc29sdmVyOiBhbnkpID0+IHtcbiAgICAgICAgc3dpdGNoIChyZXNvbHZlci50eXBlTmFtZSkge1xuICAgICAgICAgIGNhc2UgJ1F1ZXJ5JzpcbiAgICAgICAgICBjYXNlICdNdXRhdGlvbic6XG4gICAgICAgICAgY2FzZSAnU3Vic2NyaXB0aW9uJzpcbiAgICAgICAgICAgIGRlbGV0ZSByZXNvbHZlcnNbcmVzb2x2ZXIuZmllbGROYW1lXTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLmh0dHBSZXNvbHZlcnMgPSB0aGlzLm91dHB1dHMuaHR0cFJlc29sdmVycyA/PyB7fTtcblxuICAgIC8vIFJlbW92ZSBhbnkgaHR0cCByZXNvbHZlcnMgZnJvbSB0aGUgdG90YWwgbGlzdCBvZiByZXNvbHZlcnNcbiAgICAvLyBPdGhlcndpc2UgaXQgd2lsbCBhZGQgdGhlbSB0d2ljZVxuICAgIGZvciAoY29uc3QgW18sIGh0dHBSZXNvbHZlcnNdIG9mIE9iamVjdC5lbnRyaWVzKHRoaXMuaHR0cFJlc29sdmVycykpIHtcbiAgICAgIGh0dHBSZXNvbHZlcnMuZm9yRWFjaCgocmVzb2x2ZXI6IGFueSkgPT4ge1xuICAgICAgICBzd2l0Y2ggKHJlc29sdmVyLnR5cGVOYW1lKSB7XG4gICAgICAgICAgY2FzZSAnUXVlcnknOlxuICAgICAgICAgIGNhc2UgJ011dGF0aW9uJzpcbiAgICAgICAgICBjYXNlICdTdWJzY3JpcHRpb24nOlxuICAgICAgICAgICAgZGVsZXRlIHJlc29sdmVyc1tyZXNvbHZlci5maWVsZE5hbWVdO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHRoaXMucmVzb2x2ZXJzID0gcmVzb2x2ZXJzO1xuXG4gICAgdGhpcy5uZXN0ZWRBcHBzeW5jU3RhY2sgPSBuZXcgTmVzdGVkU3RhY2sodGhpcywgJ2FwcHN5bmMtbmVzdGVkLXN0YWNrJyk7XG5cbiAgICAvLyBBcHBTeW5jXG4gICAgdGhpcy5hcHBzeW5jQVBJID0gbmV3IEdyYXBocWxBcGkodGhpcy5uZXN0ZWRBcHBzeW5jU3RhY2ssIGAke2lkfS1hcGlgLCB7XG4gICAgICBuYW1lOiBwcm9wcy5hcGlOYW1lID8gcHJvcHMuYXBpTmFtZSA6IGAke2lkfS1hcGlgLFxuICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzogcHJvcHMuYXV0aG9yaXphdGlvbkNvbmZpZ1xuICAgICAgICA/IHByb3BzLmF1dGhvcml6YXRpb25Db25maWdcbiAgICAgICAgOiBkZWZhdWx0QXV0aG9yaXphdGlvbkNvbmZpZyxcbiAgICAgIGxvZ0NvbmZpZzoge1xuICAgICAgICBmaWVsZExvZ0xldmVsOiBwcm9wcy5maWVsZExvZ0xldmVsXG4gICAgICAgICAgPyBwcm9wcy5maWVsZExvZ0xldmVsXG4gICAgICAgICAgOiBGaWVsZExvZ0xldmVsLk5PTkUsXG4gICAgICB9LFxuICAgICAgc2NoZW1hOiBTY2hlbWEuZnJvbUFzc2V0KCcuL2FwcHN5bmMvc2NoZW1hLmdyYXBocWwnKSxcbiAgICAgIHhyYXlFbmFibGVkOiBwcm9wcy54cmF5RW5hYmxlZCA/PyBmYWxzZSxcbiAgICB9KTtcblxuICAgIGxldCB0YWJsZURhdGEgPSB0aGlzLm91dHB1dHMuY2RrVGFibGVzID8/IHt9O1xuXG4gICAgLy8gQ2hlY2sgdG8gc2VlIGlmIHN5bmMgaXMgZW5hYmxlZFxuICAgIGlmICh0YWJsZURhdGEuRGF0YVN0b3JlKSB7XG4gICAgICB0aGlzLmlzU3luY0VuYWJsZWQgPSB0cnVlO1xuICAgICAgdGhpcy5zeW5jVGFibGUgPSB0aGlzLmNyZWF0ZVN5bmNUYWJsZSh0YWJsZURhdGEuRGF0YVN0b3JlKTtcbiAgICAgIGRlbGV0ZSB0YWJsZURhdGEuRGF0YVN0b3JlOyAvLyBXZSBkb24ndCB3YW50IHRvIGNyZWF0ZSB0aGlzIGFnYWluIGJlbG93IHNvIHJlbW92ZSBpdCBmcm9tIHRoZSB0YWJsZURhdGEgbWFwXG4gICAgfVxuXG4gICAgdGhpcy50YWJsZU5hbWVNYXAgPSB0aGlzLmNyZWF0ZVRhYmxlc0FuZFJlc29sdmVycyh0YWJsZURhdGEsIHJlc29sdmVycyk7XG4gICAgaWYgKHRoaXMub3V0cHV0cy5ub25lUmVzb2x2ZXJzKSB7XG4gICAgICB0aGlzLmNyZWF0ZU5vbmVEYXRhU291cmNlQW5kUmVzb2x2ZXJzKFxuICAgICAgICB0aGlzLm91dHB1dHMubm9uZVJlc29sdmVycyxcbiAgICAgICAgcmVzb2x2ZXJzLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5jcmVhdGVIdHRwUmVzb2x2ZXJzKCk7XG5cbiAgICAvLyBPdXRwdXRzIHNvIHdlIGNhbiBnZW5lcmF0ZSBleHBvcnRzXG4gICAgbmV3IENmbk91dHB1dChzY29wZSwgJ2FwcHN5bmNHcmFwaFFMRW5kcG9pbnRPdXRwdXQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5hcHBzeW5jQVBJLmdyYXBocWxVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ091dHB1dCBmb3IgYXdzX2FwcHN5bmNfZ3JhcGhxbEVuZHBvaW50JyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBncmFwaHFsLXRyYW5zZm9ybWVyLWNvcmUgbmVlZHMgdG8gYmUganNpaSBlbmFibGVkIHRvIHB1bGwgdGhlIElUcmFuc2Zvcm1lciBpbnRlcmZhY2UgY29ycmVjdGx5LlxuICAgKiBTaW5jZSBpdCdzIG5vdCBpbiBwZWVyIGRlcGVuZGVuY2llcyBpdCBkb2Vzbid0IHNob3cgdXAgaW4gdGhlIGpzaWkgZGVwcyBsaXN0LlxuICAgKiBTaW5jZSBpdCdzIG5vdCBqc2lpIGVuYWJsZWQgaXQgaGFzIHRvIGJlIGJ1bmRsZWQuXG4gICAqIFRoZSBwYWNrYWdlIGNhbid0IGJlIGluIEJPVEggcGVlciBhbmQgYnVuZGxlZCBkZXBlbmRlbmNpZXNcbiAgICogU28gd2UgZG8gYSBmYWtlIHRlc3QgdG8gbWFrZSBzdXJlIGl0IGltcGxlbWVudHMgdGhlc2UgYW5kIGhvcGUgZm9yIHRoZSBiZXN0XG4gICAqIEBwYXJhbSB0cmFuc2Zvcm1lclxuICAgKi9cbiAgcHJpdmF0ZSBpbXBsZW1lbnRzSVRyYW5zZm9ybWVyKHRyYW5zZm9ybWVyOiBhbnkpIHtcbiAgICByZXR1cm4gJ25hbWUnIGluIHRyYW5zZm9ybWVyXG4gICAgICAmJiAnZGlyZWN0aXZlJyBpbiB0cmFuc2Zvcm1lclxuICAgICAgJiYgJ3R5cGVEZWZpbml0aW9ucycgaW4gdHJhbnNmb3JtZXI7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlcyBOT05FIGRhdGEgc291cmNlIGFuZCBhc3NvY2lhdGVkIHJlc29sdmVyc1xuICAgKiBAcGFyYW0gbm9uZVJlc29sdmVycyBUaGUgcmVzb2x2ZXJzIHRoYXQgYmVsb25nIHRvIHRoZSBub25lIGRhdGEgc291cmNlXG4gICAqIEBwYXJhbSByZXNvbHZlcnMgVGhlIHJlc29sdmVyIG1hcCBtaW51cyBmdW5jdGlvbiByZXNvbHZlcnNcbiAgICovXG4gIHByaXZhdGUgY3JlYXRlTm9uZURhdGFTb3VyY2VBbmRSZXNvbHZlcnMoXG4gICAgbm9uZVJlc29sdmVyczogeyBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJSZXNvbHZlciB9LFxuICAgIHJlc29sdmVyczogYW55LFxuICApIHtcbiAgICBjb25zdCBub25lRGF0YVNvdXJjZSA9IHRoaXMuYXBwc3luY0FQSS5hZGROb25lRGF0YVNvdXJjZSgnTk9ORScpO1xuXG4gICAgT2JqZWN0LmtleXMobm9uZVJlc29sdmVycykuZm9yRWFjaCgocmVzb2x2ZXJLZXk6IGFueSkgPT4ge1xuICAgICAgY29uc3QgcmVzb2x2ZXIgPSByZXNvbHZlcnNbcmVzb2x2ZXJLZXldO1xuICAgICAgbmV3IFJlc29sdmVyKFxuICAgICAgICB0aGlzLm5lc3RlZEFwcHN5bmNTdGFjayxcbiAgICAgICAgYCR7cmVzb2x2ZXIudHlwZU5hbWV9LSR7cmVzb2x2ZXIuZmllbGROYW1lfS1yZXNvbHZlcmAsXG4gICAgICAgIHtcbiAgICAgICAgICBhcGk6IHRoaXMuYXBwc3luY0FQSSxcbiAgICAgICAgICB0eXBlTmFtZTogcmVzb2x2ZXIudHlwZU5hbWUsXG4gICAgICAgICAgZmllbGROYW1lOiByZXNvbHZlci5maWVsZE5hbWUsXG4gICAgICAgICAgZGF0YVNvdXJjZTogbm9uZURhdGFTb3VyY2UsXG4gICAgICAgICAgcmVxdWVzdE1hcHBpbmdUZW1wbGF0ZTogTWFwcGluZ1RlbXBsYXRlLmZyb21GaWxlKFxuICAgICAgICAgICAgcmVzb2x2ZXIucmVxdWVzdE1hcHBpbmdUZW1wbGF0ZSxcbiAgICAgICAgICApLFxuICAgICAgICAgIHJlc3BvbnNlTWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbUZpbGUoXG4gICAgICAgICAgICByZXNvbHZlci5yZXNwb25zZU1hcHBpbmdUZW1wbGF0ZSxcbiAgICAgICAgICApLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIGVhY2ggZHluYW1vZGIgdGFibGUsIGdzaXMsIGR5bmFtb2RiIGRhdGFzb3VyY2UsIGFuZCBhc3NvY2lhdGVkIHJlc29sdmVyc1xuICAgKiBJZiBzeW5jIGlzIGVuYWJsZWQgdGhlbiBUVEwgY29uZmlndXJhdGlvbiBpcyBhZGRlZFxuICAgKiBSZXR1cm5zIHRhYmxlTmFtZTogdGFibGUgbWFwIGluIGNhc2UgaXQgaXMgbmVlZGVkIGZvciBsYW1iZGEgZnVuY3Rpb25zLCBldGNcbiAgICogQHBhcmFtIHRhYmxlRGF0YSBUaGUgQ2RrVHJhbnNmb3JtZXIgdGFibGUgaW5mb3JtYXRpb25cbiAgICogQHBhcmFtIHJlc29sdmVycyBUaGUgcmVzb2x2ZXIgbWFwIG1pbnVzIGZ1bmN0aW9uIHJlc29sdmVyc1xuICAgKi9cbiAgcHJpdmF0ZSBjcmVhdGVUYWJsZXNBbmRSZXNvbHZlcnMoXG4gICAgdGFibGVEYXRhOiB7IFtuYW1lOiBzdHJpbmddOiBDZGtUcmFuc2Zvcm1lclRhYmxlIH0sXG4gICAgcmVzb2x2ZXJzOiBhbnksXG4gICk6IHsgW25hbWU6IHN0cmluZ106IHN0cmluZyB9IHtcbiAgICBjb25zdCB0YWJsZU5hbWVNYXA6IGFueSA9IHt9O1xuXG4gICAgT2JqZWN0LmtleXModGFibGVEYXRhKS5mb3JFYWNoKCh0YWJsZUtleTogYW55KSA9PiB7XG4gICAgICBjb25zdCB0YWJsZSA9IHRoaXMuY3JlYXRlVGFibGUodGFibGVEYXRhW3RhYmxlS2V5XSk7XG4gICAgICBjb25zdCBkYXRhU291cmNlID0gdGhpcy5hcHBzeW5jQVBJLmFkZER5bmFtb0RiRGF0YVNvdXJjZSh0YWJsZUtleSwgdGFibGUpO1xuXG4gICAgICAvLyBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vQVdTQ2xvdWRGb3JtYXRpb24vbGF0ZXN0L1VzZXJHdWlkZS9hd3MtcHJvcGVydGllcy1hcHBzeW5jLWRhdGFzb3VyY2UtZGVsdGFzeW5jY29uZmlnLmh0bWxcblxuICAgICAgaWYgKHRoaXMuaXNTeW5jRW5hYmxlZCAmJiB0aGlzLnN5bmNUYWJsZSkge1xuICAgICAgICAvL0B0cy1pZ25vcmUgLSBkcyBpcyB0aGUgYmFzZSBDZm5EYXRhU291cmNlIGFuZCB0aGUgZGIgY29uZmlnIG5lZWRzIHRvIGJlIHZlcnNpb25lZCAtIHNlZSBDZm5EYXRhU291cmNlXG4gICAgICAgIGRhdGFTb3VyY2UuZHMuZHluYW1vRGJDb25maWcudmVyc2lvbmVkID0gdHJ1ZTtcblxuICAgICAgICAvL0B0cy1pZ25vcmUgLSBkcyBpcyB0aGUgYmFzZSBDZm5EYXRhU291cmNlIC0gc2VlIENmbkRhdGFTb3VyY2VcbiAgICAgICAgZGF0YVNvdXJjZS5kcy5keW5hbW9EYkNvbmZpZy5kZWx0YVN5bmNDb25maWcgPSB7XG4gICAgICAgICAgYmFzZVRhYmxlVHRsOiAnNDMyMDAnLCAvLyBHb3QgdGhpcyB2YWx1ZSBmcm9tIGFtcGxpZnkgLSAzMCBkYXlzIGluIG1pbnV0ZXNcbiAgICAgICAgICBkZWx0YVN5bmNUYWJsZU5hbWU6IHRoaXMuc3luY1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgICBkZWx0YVN5bmNUYWJsZVR0bDogJzMwJywgLy8gR290IHRoaXMgdmFsdWUgZnJvbSBhbXBsaWZ5IC0gMzAgbWludXRlc1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vIE5lZWQgdG8gYWRkIHBlcm1pc3Npb24gZm9yIG91ciBkYXRhc291cmNlIHNlcnZpY2Ugcm9sZSB0byBhY2Nlc3MgdGhlIHN5bmMgdGFibGVcbiAgICAgICAgZGF0YVNvdXJjZS5ncmFudFByaW5jaXBhbC5hZGRUb1BvbGljeShcbiAgICAgICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAnZHluYW1vZGI6KicsIC8vIFRPRE86IFRoaXMgbWF5IGJlIHRvbyBwZXJtaXNzaXZlXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5zeW5jVGFibGUudGFibGVBcm5dLFxuICAgICAgICAgIH0pLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkeW5hbW9EYkNvbmZpZyA9IGRhdGFTb3VyY2UuZHNcbiAgICAgICAgLmR5bmFtb0RiQ29uZmlnIGFzIENmbkRhdGFTb3VyY2UuRHluYW1vREJDb25maWdQcm9wZXJ0eTtcbiAgICAgIHRhYmxlTmFtZU1hcFt0YWJsZUtleV0gPSBkeW5hbW9EYkNvbmZpZy50YWJsZU5hbWU7XG5cbiAgICAgIC8vIExvb3AgdGhlIGJhc2ljIHJlc29sdmVyc1xuICAgICAgdGFibGVEYXRhW3RhYmxlS2V5XS5yZXNvbHZlcnMuZm9yRWFjaCgocmVzb2x2ZXJLZXk6IGFueSkgPT4ge1xuICAgICAgICBsZXQgcmVzb2x2ZXIgPSByZXNvbHZlcnNbcmVzb2x2ZXJLZXldO1xuICAgICAgICBuZXcgUmVzb2x2ZXIoXG4gICAgICAgICAgdGhpcy5uZXN0ZWRBcHBzeW5jU3RhY2ssXG4gICAgICAgICAgYCR7cmVzb2x2ZXIudHlwZU5hbWV9LSR7cmVzb2x2ZXIuZmllbGROYW1lfS1yZXNvbHZlcmAsXG4gICAgICAgICAge1xuICAgICAgICAgICAgYXBpOiB0aGlzLmFwcHN5bmNBUEksXG4gICAgICAgICAgICB0eXBlTmFtZTogcmVzb2x2ZXIudHlwZU5hbWUsXG4gICAgICAgICAgICBmaWVsZE5hbWU6IHJlc29sdmVyLmZpZWxkTmFtZSxcbiAgICAgICAgICAgIGRhdGFTb3VyY2U6IGRhdGFTb3VyY2UsXG4gICAgICAgICAgICByZXF1ZXN0TWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbUZpbGUoXG4gICAgICAgICAgICAgIHJlc29sdmVyLnJlcXVlc3RNYXBwaW5nVGVtcGxhdGUsXG4gICAgICAgICAgICApLFxuICAgICAgICAgICAgcmVzcG9uc2VNYXBwaW5nVGVtcGxhdGU6IE1hcHBpbmdUZW1wbGF0ZS5mcm9tRmlsZShcbiAgICAgICAgICAgICAgcmVzb2x2ZXIucmVzcG9uc2VNYXBwaW5nVGVtcGxhdGUsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgICB9KTtcblxuICAgICAgLy8gTG9vcCB0aGUgZ3NpIHJlc29sdmVyc1xuICAgICAgdGFibGVEYXRhW3RhYmxlS2V5XS5nc2lSZXNvbHZlcnMuZm9yRWFjaCgocmVzb2x2ZXJLZXk6IGFueSkgPT4ge1xuICAgICAgICBsZXQgcmVzb2x2ZXIgPSByZXNvbHZlcnMuZ3NpW3Jlc29sdmVyS2V5XTtcbiAgICAgICAgbmV3IFJlc29sdmVyKFxuICAgICAgICAgIHRoaXMubmVzdGVkQXBwc3luY1N0YWNrLFxuICAgICAgICAgIGAke3Jlc29sdmVyLnR5cGVOYW1lfS0ke3Jlc29sdmVyLmZpZWxkTmFtZX0tcmVzb2x2ZXJgLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGFwaTogdGhpcy5hcHBzeW5jQVBJLFxuICAgICAgICAgICAgdHlwZU5hbWU6IHJlc29sdmVyLnR5cGVOYW1lLFxuICAgICAgICAgICAgZmllbGROYW1lOiByZXNvbHZlci5maWVsZE5hbWUsXG4gICAgICAgICAgICBkYXRhU291cmNlOiBkYXRhU291cmNlLFxuICAgICAgICAgICAgcmVxdWVzdE1hcHBpbmdUZW1wbGF0ZTogTWFwcGluZ1RlbXBsYXRlLmZyb21GaWxlKFxuICAgICAgICAgICAgICByZXNvbHZlci5yZXF1ZXN0TWFwcGluZ1RlbXBsYXRlLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIHJlc3BvbnNlTWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbUZpbGUoXG4gICAgICAgICAgICAgIHJlc29sdmVyLnJlc3BvbnNlTWFwcGluZ1RlbXBsYXRlLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdGFibGVOYW1lTWFwO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVUYWJsZSh0YWJsZURhdGE6IENka1RyYW5zZm9ybWVyVGFibGUpIHtcbiAgICBsZXQgdGFibGVQcm9wczogYW55ID0ge1xuICAgICAgYmlsbGluZ01vZGU6IEJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiB0YWJsZURhdGEucGFydGl0aW9uS2V5Lm5hbWUsXG4gICAgICAgIHR5cGU6IHRoaXMuY29udmVydEF0dHJpYnV0ZVR5cGUodGFibGVEYXRhLnBhcnRpdGlvbktleS50eXBlKSxcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGlmICh0YWJsZURhdGEuc29ydEtleSAmJiB0YWJsZURhdGEuc29ydEtleS5uYW1lKSB7XG4gICAgICB0YWJsZVByb3BzLnNvcnRLZXkgPSB7XG4gICAgICAgIG5hbWU6IHRhYmxlRGF0YS5zb3J0S2V5Lm5hbWUsXG4gICAgICAgIHR5cGU6IHRoaXMuY29udmVydEF0dHJpYnV0ZVR5cGUodGFibGVEYXRhLnNvcnRLZXkudHlwZSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmICh0YWJsZURhdGEudHRsICYmIHRhYmxlRGF0YS50dGwuZW5hYmxlZCkge1xuICAgICAgdGFibGVQcm9wcy50aW1lVG9MaXZlQXR0cmlidXRlID0gdGFibGVEYXRhLnR0bC5hdHRyaWJ1dGVOYW1lO1xuICAgIH1cblxuICAgIGNvbnN0IHRhYmxlID0gbmV3IFRhYmxlKFxuICAgICAgdGhpcy5uZXN0ZWRBcHBzeW5jU3RhY2ssXG4gICAgICB0YWJsZURhdGEudGFibGVOYW1lLFxuICAgICAgdGFibGVQcm9wcyxcbiAgICApO1xuXG4gICAgaWYgKFxuICAgICAgdGFibGVEYXRhLmdsb2JhbFNlY29uZGFyeUluZGV4ZXMgJiZcbiAgICAgIHRhYmxlRGF0YS5nbG9iYWxTZWNvbmRhcnlJbmRleGVzLmxlbmd0aCA+IDBcbiAgICApIHtcbiAgICAgIHRhYmxlRGF0YS5nbG9iYWxTZWNvbmRhcnlJbmRleGVzLmZvckVhY2goKGdzaTogYW55KSA9PiB7XG4gICAgICAgIHRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgICAgICBpbmRleE5hbWU6IGdzaS5pbmRleE5hbWUsXG4gICAgICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgICAgICBuYW1lOiBnc2kucGFydGl0aW9uS2V5Lm5hbWUsXG4gICAgICAgICAgICB0eXBlOiB0aGlzLmNvbnZlcnRBdHRyaWJ1dGVUeXBlKGdzaS5wYXJ0aXRpb25LZXkudHlwZSksXG4gICAgICAgICAgfSxcbiAgICAgICAgICBwcm9qZWN0aW9uVHlwZTogdGhpcy5jb252ZXJ0UHJvamVjdGlvblR5cGUoXG4gICAgICAgICAgICBnc2kucHJvamVjdGlvbi5Qcm9qZWN0aW9uVHlwZSxcbiAgICAgICAgICApLFxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0YWJsZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIHRoZSBzeW5jIHRhYmxlIGZvciBBbXBsaWZ5IERhdGFTdG9yZVxuICAgKiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vYXBwc3luYy9sYXRlc3QvZGV2Z3VpZGUvY29uZmxpY3QtZGV0ZWN0aW9uLWFuZC1zeW5jLmh0bWxcbiAgICogQHBhcmFtIHRhYmxlRGF0YSBUaGUgQ2RrVHJhbnNmb3JtZXIgdGFibGUgaW5mb3JtYXRpb25cbiAgICovXG4gIHByaXZhdGUgY3JlYXRlU3luY1RhYmxlKHRhYmxlRGF0YTogQ2RrVHJhbnNmb3JtZXJUYWJsZSk6IFRhYmxlIHtcbiAgICByZXR1cm4gbmV3IFRhYmxlKHRoaXMsICdhcHBzeW5jLWFwaS1zeW5jLXRhYmxlJywge1xuICAgICAgYmlsbGluZ01vZGU6IEJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiB0YWJsZURhdGEucGFydGl0aW9uS2V5Lm5hbWUsXG4gICAgICAgIHR5cGU6IHRoaXMuY29udmVydEF0dHJpYnV0ZVR5cGUodGFibGVEYXRhLnBhcnRpdGlvbktleS50eXBlKSxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6IHRhYmxlRGF0YS5zb3J0S2V5IS5uYW1lLCAvLyBXZSBrbm93IGl0IGhhcyBhIHNvcnRrZXkgYmVjYXVzZSB3ZSBmb3JjZWQgaXQgdG9cbiAgICAgICAgdHlwZTogdGhpcy5jb252ZXJ0QXR0cmlidXRlVHlwZSh0YWJsZURhdGEuc29ydEtleSEudHlwZSksIC8vIFdlIGtub3cgaXQgaGFzIGEgc29ydGtleSBiZWNhdXNlIHdlIGZvcmNlZCBpdCB0b1xuICAgICAgfSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IHRhYmxlRGF0YS50dGw/LmF0dHJpYnV0ZU5hbWUgfHwgJ190dGwnLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjb252ZXJ0QXR0cmlidXRlVHlwZSh0eXBlOiBzdHJpbmcpOiBBdHRyaWJ1dGVUeXBlIHtcbiAgICBzd2l0Y2ggKHR5cGUpIHtcbiAgICAgIGNhc2UgJ04nOlxuICAgICAgICByZXR1cm4gQXR0cmlidXRlVHlwZS5OVU1CRVI7XG4gICAgICBjYXNlICdCJzpcbiAgICAgICAgcmV0dXJuIEF0dHJpYnV0ZVR5cGUuQklOQVJZO1xuICAgICAgY2FzZSAnUyc6IC8vIFNhbWUgYXMgZGVmYXVsdFxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIEF0dHJpYnV0ZVR5cGUuU1RSSU5HO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY29udmVydFByb2plY3Rpb25UeXBlKHR5cGU6IHN0cmluZyk6IFByb2plY3Rpb25UeXBlIHtcbiAgICBzd2l0Y2ggKHR5cGUpIHtcbiAgICAgIGNhc2UgJ0lOQ0xVREUnOlxuICAgICAgICByZXR1cm4gUHJvamVjdGlvblR5cGUuSU5DTFVERTtcbiAgICAgIGNhc2UgJ0tFWVNfT05MWSc6XG4gICAgICAgIHJldHVybiBQcm9qZWN0aW9uVHlwZS5LRVlTX09OTFk7XG4gICAgICBjYXNlICdBTEwnOiAvLyBTYW1lIGFzIGRlZmF1bHRcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybiBQcm9qZWN0aW9uVHlwZS5BTEw7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVIdHRwUmVzb2x2ZXJzKCkge1xuICAgIGZvciAoY29uc3QgW2VuZHBvaW50LCBodHRwUmVzb2x2ZXJzXSBvZiBPYmplY3QuZW50cmllcyhcbiAgICAgIHRoaXMuaHR0cFJlc29sdmVycyxcbiAgICApKSB7XG4gICAgICBjb25zdCBzdHJpcHBlZEVuZHBvaW50ID0gZW5kcG9pbnQucmVwbGFjZSgvW15fMC05QS1aYS16XS9nLCAnJyk7XG4gICAgICBjb25zdCBodHRwRGF0YVNvdXJjZSA9IHRoaXMuYXBwc3luY0FQSS5hZGRIdHRwRGF0YVNvdXJjZShcbiAgICAgICAgYCR7c3RyaXBwZWRFbmRwb2ludH1gLFxuICAgICAgICBlbmRwb2ludCxcbiAgICAgICk7XG5cbiAgICAgIGh0dHBSZXNvbHZlcnMuZm9yRWFjaCgocmVzb2x2ZXI6IENka1RyYW5zZm9ybWVySHR0cFJlc29sdmVyKSA9PiB7XG4gICAgICAgIG5ldyBSZXNvbHZlcihcbiAgICAgICAgICB0aGlzLm5lc3RlZEFwcHN5bmNTdGFjayxcbiAgICAgICAgICBgJHtyZXNvbHZlci50eXBlTmFtZX0tJHtyZXNvbHZlci5maWVsZE5hbWV9LXJlc29sdmVyYCxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhcGk6IHRoaXMuYXBwc3luY0FQSSxcbiAgICAgICAgICAgIHR5cGVOYW1lOiByZXNvbHZlci50eXBlTmFtZSxcbiAgICAgICAgICAgIGZpZWxkTmFtZTogcmVzb2x2ZXIuZmllbGROYW1lLFxuICAgICAgICAgICAgZGF0YVNvdXJjZTogaHR0cERhdGFTb3VyY2UsXG4gICAgICAgICAgICByZXF1ZXN0TWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbVN0cmluZyhcbiAgICAgICAgICAgICAgcmVzb2x2ZXIuZGVmYXVsdFJlcXVlc3RNYXBwaW5nVGVtcGxhdGUsXG4gICAgICAgICAgICApLFxuICAgICAgICAgICAgcmVzcG9uc2VNYXBwaW5nVGVtcGxhdGU6IE1hcHBpbmdUZW1wbGF0ZS5mcm9tU3RyaW5nKFxuICAgICAgICAgICAgICByZXNvbHZlci5kZWZhdWx0UmVzcG9uc2VNYXBwaW5nVGVtcGxhdGUsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gIHB1YmxpYyBhZGRMYW1iZGFEYXRhU291cmNlQW5kUmVzb2x2ZXJzKFxuICAgIGZ1bmN0aW9uTmFtZTogc3RyaW5nLFxuICAgIGlkOiBzdHJpbmcsXG4gICAgbGFtYmRhRnVuY3Rpb246IElGdW5jdGlvbixcbiAgICBvcHRpb25zPzogRGF0YVNvdXJjZU9wdGlvbnMsXG4gICk6IExhbWJkYURhdGFTb3VyY2Uge1xuICAgIGNvbnN0IGZ1bmN0aW9uRGF0YVNvdXJjZSA9IHRoaXMuYXBwc3luY0FQSS5hZGRMYW1iZGFEYXRhU291cmNlKFxuICAgICAgaWQsXG4gICAgICBsYW1iZGFGdW5jdGlvbixcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcblxuICAgIGZvciAoY29uc3QgcmVzb2x2ZXIgb2YgdGhpcy5mdW5jdGlvblJlc29sdmVyc1tmdW5jdGlvbk5hbWVdKSB7XG4gICAgICBuZXcgUmVzb2x2ZXIoXG4gICAgICAgIHRoaXMubmVzdGVkQXBwc3luY1N0YWNrLFxuICAgICAgICBgJHtyZXNvbHZlci50eXBlTmFtZX0tJHtyZXNvbHZlci5maWVsZE5hbWV9LXJlc29sdmVyYCxcbiAgICAgICAge1xuICAgICAgICAgIGFwaTogdGhpcy5hcHBzeW5jQVBJLFxuICAgICAgICAgIHR5cGVOYW1lOiByZXNvbHZlci50eXBlTmFtZSxcbiAgICAgICAgICBmaWVsZE5hbWU6IHJlc29sdmVyLmZpZWxkTmFtZSxcbiAgICAgICAgICBkYXRhU291cmNlOiBmdW5jdGlvbkRhdGFTb3VyY2UsXG4gICAgICAgICAgcmVxdWVzdE1hcHBpbmdUZW1wbGF0ZTogTWFwcGluZ1RlbXBsYXRlLmZyb21TdHJpbmcoXG4gICAgICAgICAgICByZXNvbHZlci5kZWZhdWx0UmVxdWVzdE1hcHBpbmdUZW1wbGF0ZSxcbiAgICAgICAgICApLFxuICAgICAgICAgIHJlc3BvbnNlTWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbVN0cmluZyhcbiAgICAgICAgICAgIHJlc29sdmVyLmRlZmF1bHRSZXNwb25zZU1hcHBpbmdUZW1wbGF0ZSxcbiAgICAgICAgICApLCAvLyBUaGlzIGRlZmF1bHRzIHRvIGFsbG93IGVycm9ycyB0byByZXR1cm4gdG8gdGhlIGNsaWVudCBpbnN0ZWFkIG9mIHRocm93aW5nXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiBmdW5jdGlvbkRhdGFTb3VyY2U7XG4gIH1cbn1cbiJdfQ==
