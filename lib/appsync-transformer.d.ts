import {
  GraphqlApi,
  FieldLogLevel,
  AuthorizationConfig,
  DataSourceOptions,
  LambdaDataSource,
} from "@aws-cdk/aws-appsync";
import { StreamViewType, Table } from "@aws-cdk/aws-dynamodb";
import { IFunction } from "@aws-cdk/aws-lambda";
import { Construct, NestedStack } from "@aws-cdk/core";
import {
  CdkTransformerFunctionResolver,
  CdkTransformerHttpResolver,
  SchemaTransformerOutputs,
} from "./transformer";
/**
 * @experimental
 */
export interface AppSyncTransformerProps {
  /**
   * (experimental) Relative path where schema.graphql exists.
   *
   * @experimental
   */
  readonly schemaPath: string;
  /**
   * (experimental) Optional.
   *
   * {@link AuthorizationConfig} type defining authorization for AppSync GraphqlApi. Defaults to API_KEY
   *
   * @default API_KEY authorization config
   * @experimental
   */
  readonly authorizationConfig?: AuthorizationConfig;
  /**
   * (experimental) String value representing the api name.
   *
   * @default `${id}-api`
   * @experimental
   */
  readonly apiName?: string;
  /**
   * (experimental) Whether to enable Amplify DataStore and Sync Tables.
   *
   * @default false
   * @experimental
   */
  readonly syncEnabled?: boolean;
  /**
   * (experimental) Optional.
   *
   * {@link FieldLogLevel} type for AppSync GraphqlApi log level
   *
   * @default FieldLogLevel.NONE
   * @experimental
   */
  readonly fieldLogLevel?: FieldLogLevel;
  /**
   * (experimental) Determines whether xray should be enabled on the AppSync API.
   *
   * @default false
   * @experimental
   */
  readonly xrayEnabled?: boolean;
  /**
   * (experimental) Optional.
   *
   * Additonal custom transformers to run prior to the CDK resource generations.
   * Particularly useful for custom directives.
   * These should extend Transformer class from graphql-transformer-core
   *
   * @default undefined
   * @experimental
   */
  readonly preCdkTransformers?: any[];
  /**
   * (experimental) Optional.
   *
   * Additonal custom transformers to run after the CDK resource generations.
   * Mostly useful for deep level customization of the generated CDK CloudFormation resources.
   * These should extend Transformer class from graphql-transformer-core
   *
   * @default undefined
   * @experimental
   */
  readonly postCdkTransformers?: any[];

  /**
   * Add streams to specific table
   *
   * *stream*: DynamoDB stream type
   *
   * *table*: name of the type for which you want to enable the stream
   *
   * @default undefined
   * @experimental
   */
  readonly streamPerTable?: Array<{ stream: StreamViewType; table: string }>;
}
/**
 * (experimental) AppSyncTransformer Construct.
 *
 * @experimental
 */
export declare class AppSyncTransformer extends Construct {
  /**
   * (experimental) The cdk GraphqlApi construct.
   *
   * @experimental
   */
  readonly appsyncAPI: GraphqlApi;
  /**
   * (experimental) The NestedStack that contains the AppSync resources.
   *
   * @experimental
   */
  readonly nestedAppsyncStack: NestedStack;
  /**
   * (experimental) Map of cdk table tokens to table names.
   *
   * @experimental
   */
  readonly tableNameMap: {
    [name: string]: any;
  };

  /**
   * (experimental) Map of cdk table tokens to table.
   *
   * @experimental
   */
  readonly tableMap: {
    [name: string]: Table;
  };
  /**
   * (experimental) The outputs from the SchemaTransformer.
   *
   * @experimental
   */
  readonly outputs: SchemaTransformerOutputs;
  /**
   * (experimental) The AppSync resolvers from the transformer minus any function resolvers.
   *
   * @experimental
   */
  readonly resolvers: any;
  /**
   * (experimental) The Lambda Function resolvers designated by the function directive https://github.com/kcwinner/cdk-appsync-transformer#functions.
   *
   * @experimental
   */
  readonly functionResolvers: {
    [name: string]: CdkTransformerFunctionResolver[];
  };
  /**
   * @experimental
   */
  readonly httpResolvers: {
    [name: string]: CdkTransformerHttpResolver[];
  };
  private isSyncEnabled;
  private syncTable;
  /**
   * @experimental
   */
  constructor(scope: Construct, id: string, props: AppSyncTransformerProps);
  /**
   * graphql-transformer-core needs to be jsii enabled to pull the ITransformer interface correctly.
   * Since it's not in peer dependencies it doesn't show up in the jsii deps list.
   * Since it's not jsii enabled it has to be bundled.
   * The package can't be in BOTH peer and bundled dependencies
   * So we do a fake test to make sure it implements these and hope for the best
   * @param transformer
   */
  private implementsITransformer;
  /**
   * Creates NONE data source and associated resolvers
   * @param noneResolvers The resolvers that belong to the none data source
   * @param resolvers The resolver map minus function resolvers
   */
  private createNoneDataSourceAndResolvers;
  /**
   * Creates each dynamodb table, gsis, dynamodb datasource, and associated resolvers
   * If sync is enabled then TTL configuration is added
   * Returns tableName: table map in case it is needed for lambda functions, etc
   * @param tableData The CdkTransformer table information
   * @param resolvers The resolver map minus function resolvers
   */
  private createTablesAndResolvers;
  private createTable;
  /**
   * Creates the sync table for Amplify DataStore
   * https://docs.aws.amazon.com/appsync/latest/devguide/conflict-detection-and-sync.html
   * @param tableData The CdkTransformer table information
   */
  private createSyncTable;
  private convertAttributeType;
  private convertProjectionType;
  private createHttpResolvers;
  /**
   * (experimental) Adds the function as a lambdaDataSource to the AppSync api Adds all of the functions resolvers to the AppSync api.
   *
   * @param functionName The function name specified in the.
   * @param id The id to give.
   * @param lambdaFunction The lambda function to attach.
   * @experimental
   * @function directive of the schema
   */
  addLambdaDataSourceAndResolvers(
    functionName: string,
    id: string,
    lambdaFunction: IFunction,
    options?: DataSourceOptions
  ): LambdaDataSource;
}
