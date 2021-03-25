"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaTransformer = void 0;
const fs = require("fs");
const path_1 = require("path");
const graphql_auth_transformer_1 = require("graphql-auth-transformer");
const graphql_connection_transformer_1 = require("graphql-connection-transformer");
const graphql_dynamodb_transformer_1 = require("graphql-dynamodb-transformer");
const graphql_http_transformer_1 = require("graphql-http-transformer");
const graphql_key_transformer_1 = require("graphql-key-transformer");
const graphql_transformer_core_1 = require("graphql-transformer-core");
const graphql_ttl_transformer_1 = require("graphql-ttl-transformer");
const graphql_versioned_transformer_1 = require("graphql-versioned-transformer");
const cdk_transformer_1 = require("./cdk-transformer");
// Import this way because FunctionTransformer.d.ts types were throwing an eror. And we didn't write this package so hope for the best :P
// eslint-disable-next-line
const { FunctionTransformer } = require('graphql-function-transformer');
class SchemaTransformer {
    constructor(props) {
        this.schemaPath = props.schemaPath || './schema.graphql';
        this.outputPath = props.outputPath || './appsync';
        this.isSyncEnabled = props.syncEnabled || false;
        this.outputs = {};
        this.resolvers = {};
        // TODO: Make this better?
        this.authTransformerConfig = {
            authConfig: {
                defaultAuthentication: {
                    authenticationType: 'AMAZON_COGNITO_USER_POOLS',
                    userPoolConfig: {
                        userPoolId: '12345xyz',
                    },
                },
                additionalAuthenticationProviders: [
                    {
                        authenticationType: 'API_KEY',
                        apiKeyConfig: {
                            description: 'Testing',
                            apiKeyExpirationDays: 100,
                        },
                    },
                    {
                        authenticationType: 'AWS_IAM',
                    },
                    {
                        authenticationType: 'OPENID_CONNECT',
                        openIDConnectConfig: {
                            name: 'OIDC',
                            issuerUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXX',
                        },
                    },
                ],
            },
        };
    }
    transform(preCdkTransformers = [], postCdkTransformers = []) {
        var _a, _b;
        const transformConfig = this.isSyncEnabled ? this.loadConfigSync() : {};
        // Note: This is not exact as we are omitting the @searchable transformer as well as some others.
        const transformer = new graphql_transformer_core_1.GraphQLTransform({
            transformConfig: transformConfig,
            transformers: [
                new graphql_dynamodb_transformer_1.DynamoDBModelTransformer(),
                new graphql_ttl_transformer_1.default(),
                new graphql_versioned_transformer_1.VersionedModelTransformer(),
                new FunctionTransformer(),
                new graphql_key_transformer_1.KeyTransformer(),
                new graphql_connection_transformer_1.ModelConnectionTransformer(),
                new graphql_auth_transformer_1.ModelAuthTransformer(this.authTransformerConfig),
                new graphql_http_transformer_1.HttpTransformer(),
                ...preCdkTransformers,
                new cdk_transformer_1.CdkTransformer(),
                ...postCdkTransformers,
            ],
        });
        const schema = fs.readFileSync(this.schemaPath);
        const cfdoc = transformer.transform(schema.toString());
        // TODO: Get Unauth Role and Auth Role policies for authorization stuff
        this.unauthRolePolicy = ((_a = cfdoc.rootStack.Resources) === null || _a === void 0 ? void 0 : _a.UnauthRolePolicy01) || undefined;
        this.writeSchema(cfdoc.schema);
        this.writeResolversToFile(cfdoc.resolvers);
        // Outputs shouldn't be null but default to empty map
        this.outputs = (_b = cfdoc.rootStack.Outputs) !== null && _b !== void 0 ? _b : {};
        return this.outputs;
    }
    /**
       *
       */
    getResolvers() {
        const statements = ['Query', 'Mutation'];
        const resolversDirPath = path_1.normalize('./appsync/resolvers');
        if (fs.existsSync(resolversDirPath)) {
            const files = fs.readdirSync(resolversDirPath);
            files.forEach(file => {
                // Example: Mutation.createChannel.response
                let args = file.split('.');
                let typeName = args[0];
                let fieldName = args[1];
                let templateType = args[2]; // request or response
                // default to composite key of typeName and fieldName, however if it
                // is Query, Mutation or Subscription (top level) the compositeKey is the
                // same as fieldName only
                let compositeKey = `${typeName}${fieldName}`;
                if (statements.indexOf(typeName) >= 0) {
                    compositeKey = fieldName;
                }
                let filepath = path_1.normalize(`${resolversDirPath}/${file}`);
                if (statements.indexOf(typeName) >= 0 || (this.outputs.noneResolvers && this.outputs.noneResolvers[compositeKey])) {
                    if (!this.resolvers[compositeKey]) {
                        this.resolvers[compositeKey] = {
                            typeName: typeName,
                            fieldName: fieldName,
                        };
                    }
                    if (templateType === 'req') {
                        this.resolvers[compositeKey].requestMappingTemplate = filepath;
                    }
                    else if (templateType === 'res') {
                        this.resolvers[compositeKey].responseMappingTemplate = filepath;
                    }
                }
                else if (this.isHttpResolver(typeName, fieldName)) {
                    if (!this.resolvers[compositeKey]) {
                        this.resolvers[compositeKey] = {
                            typeName: typeName,
                            fieldName: fieldName,
                        };
                    }
                    if (templateType === 'req') {
                        this.resolvers[compositeKey].requestMappingTemplate = filepath;
                    }
                    else if (templateType === 'res') {
                        this.resolvers[compositeKey].responseMappingTemplate = filepath;
                    }
                }
                else { // This is a GSI
                    if (!this.resolvers.gsi) {
                        this.resolvers.gsi = {};
                    }
                    if (!this.resolvers.gsi[compositeKey]) {
                        this.resolvers.gsi[compositeKey] = {
                            typeName: typeName,
                            fieldName: fieldName,
                            tableName: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
                        };
                    }
                    if (templateType === 'req') {
                        this.resolvers.gsi[compositeKey].requestMappingTemplate = filepath;
                    }
                    else if (templateType === 'res') {
                        this.resolvers.gsi[compositeKey].responseMappingTemplate = filepath;
                    }
                }
            });
        }
        return this.resolvers;
    }
    /**
     * decides if this is a resolver for an HTTP datasource
     * @param typeName
     * @param fieldName
     */
    isHttpResolver(typeName, fieldName) {
        if (!this.outputs.httpResolvers)
            return false;
        for (const endpoint in this.outputs.httpResolvers) {
            for (const resolver of this.outputs.httpResolvers[endpoint]) {
                if (resolver.typeName === typeName && resolver.fieldName === fieldName)
                    return true;
            }
        }
        return false;
    }
    /**
       * Writes the schema to the output directory for use with @aws-cdk/aws-appsync
       * @param schema
       */
    writeSchema(schema) {
        if (!fs.existsSync(this.outputPath)) {
            fs.mkdirSync(this.outputPath);
        }
        fs.writeFileSync(`${this.outputPath}/schema.graphql`, schema);
    }
    /**
       * Writes all the resolvers to the output directory for loading into the datasources later
       * @param resolvers
       */
    writeResolversToFile(resolvers) {
        if (!fs.existsSync(this.outputPath)) {
            fs.mkdirSync(this.outputPath);
        }
        const resolverFolderPath = path_1.normalize(this.outputPath + '/resolvers');
        if (fs.existsSync(resolverFolderPath)) {
            const files = fs.readdirSync(resolverFolderPath);
            files.forEach(file => fs.unlinkSync(resolverFolderPath + '/' + file));
            fs.rmdirSync(resolverFolderPath);
        }
        if (!fs.existsSync(resolverFolderPath)) {
            fs.mkdirSync(resolverFolderPath);
        }
        Object.keys(resolvers).forEach((key) => {
            const resolver = resolvers[key];
            const fileName = key.replace('.vtl', '');
            const resolverFilePath = path_1.normalize(`${resolverFolderPath}/${fileName}`);
            fs.writeFileSync(resolverFilePath, resolver);
        });
    }
    /**
       * @returns {@link TransformConfig}
      */
    loadConfigSync(projectDir = 'resources') {
        // Initialize the config always with the latest version, other members are optional for now.
        let config = {
            Version: graphql_transformer_core_1.TRANSFORM_CURRENT_VERSION,
            ResolverConfig: {
                project: {
                    ConflictHandler: "OPTIMISTIC_CONCURRENCY" /* OPTIMISTIC */,
                    ConflictDetection: 'VERSION',
                },
            },
        };
        const configDir = path_1.join(__dirname, '..', '..', projectDir);
        try {
            const configPath = path_1.join(configDir, graphql_transformer_core_1.TRANSFORM_CONFIG_FILE_NAME);
            const configExists = fs.existsSync(configPath);
            if (configExists) {
                const configStr = fs.readFileSync(configPath);
                config = JSON.parse(configStr.toString());
            }
            return config;
        }
        catch (err) {
            return config;
        }
    }
}
exports.SchemaTransformer = SchemaTransformer;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NoZW1hLXRyYW5zZm9ybWVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3RyYW5zZm9ybWVyL3NjaGVtYS10cmFuc2Zvcm1lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSx5QkFBeUI7QUFDekIsK0JBQXVDO0FBQ3ZDLHVFQUE0RjtBQUM1RixtRkFBNEU7QUFDNUUsK0VBQXdFO0FBQ3hFLHVFQUEyRDtBQUMzRCxxRUFBeUQ7QUFDekQsdUVBQXVLO0FBQ3ZLLHFFQUFxRDtBQUNyRCxpRkFBMEU7QUFFMUUsdURBTTJCO0FBSzNCLHlJQUF5STtBQUN6SSwyQkFBMkI7QUFDM0IsTUFBTSxFQUFFLG1CQUFtQixFQUFFLEdBQUcsT0FBTyxDQUFDLDhCQUE4QixDQUFDLENBQUM7QUFzQ3hFLE1BQWEsaUJBQWlCO0lBWTVCLFlBQVksS0FBNkI7UUFDdkMsSUFBSSxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUMsVUFBVSxJQUFJLGtCQUFrQixDQUFDO1FBQ3pELElBQUksQ0FBQyxVQUFVLEdBQUcsS0FBSyxDQUFDLFVBQVUsSUFBSSxXQUFXLENBQUM7UUFDbEQsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLEtBQUssQ0FBQztRQUVoRCxJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNsQixJQUFJLENBQUMsU0FBUyxHQUFHLEVBQUUsQ0FBQztRQUVwQiwwQkFBMEI7UUFDMUIsSUFBSSxDQUFDLHFCQUFxQixHQUFHO1lBQzNCLFVBQVUsRUFBRTtnQkFDVixxQkFBcUIsRUFBRTtvQkFDckIsa0JBQWtCLEVBQUUsMkJBQTJCO29CQUMvQyxjQUFjLEVBQUU7d0JBQ2QsVUFBVSxFQUFFLFVBQVU7cUJBQ3ZCO2lCQUNGO2dCQUNELGlDQUFpQyxFQUFFO29CQUNqQzt3QkFDRSxrQkFBa0IsRUFBRSxTQUFTO3dCQUM3QixZQUFZLEVBQUU7NEJBQ1osV0FBVyxFQUFFLFNBQVM7NEJBQ3RCLG9CQUFvQixFQUFFLEdBQUc7eUJBQzFCO3FCQUNGO29CQUNEO3dCQUNFLGtCQUFrQixFQUFFLFNBQVM7cUJBQzlCO29CQUNEO3dCQUNFLGtCQUFrQixFQUFFLGdCQUFnQjt3QkFDcEMsbUJBQW1CLEVBQUU7NEJBQ25CLElBQUksRUFBRSxNQUFNOzRCQUNaLFNBQVMsRUFBRSwyREFBMkQ7eUJBQ3ZFO3FCQUNGO2lCQUNGO2FBQ0Y7U0FDRixDQUFDO0lBQ0osQ0FBQztJQUVNLFNBQVMsQ0FBQyxxQkFBcUMsRUFBRSxFQUFFLHNCQUFzQyxFQUFFOztRQUNoRyxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUV4RSxpR0FBaUc7UUFDakcsTUFBTSxXQUFXLEdBQUcsSUFBSSwyQ0FBZ0IsQ0FBQztZQUN2QyxlQUFlLEVBQUUsZUFBZTtZQUNoQyxZQUFZLEVBQUU7Z0JBQ1osSUFBSSx1REFBd0IsRUFBRTtnQkFDOUIsSUFBSSxpQ0FBYyxFQUFFO2dCQUNwQixJQUFJLHlEQUF5QixFQUFFO2dCQUMvQixJQUFJLG1CQUFtQixFQUFFO2dCQUN6QixJQUFJLHdDQUFjLEVBQUU7Z0JBQ3BCLElBQUksMkRBQTBCLEVBQUU7Z0JBQ2hDLElBQUksK0NBQW9CLENBQUMsSUFBSSxDQUFDLHFCQUFxQixDQUFDO2dCQUNwRCxJQUFJLDBDQUFlLEVBQUU7Z0JBQ3JCLEdBQUcsa0JBQWtCO2dCQUNyQixJQUFJLGdDQUFjLEVBQUU7Z0JBQ3BCLEdBQUcsbUJBQW1CO2FBQ3ZCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDaEQsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztRQUV2RCx1RUFBdUU7UUFDdkUsSUFBSSxDQUFDLGdCQUFnQixHQUFHLENBQUEsTUFBQSxLQUFLLENBQUMsU0FBUyxDQUFDLFNBQVMsMENBQUUsa0JBQThCLEtBQUksU0FBUyxDQUFDO1FBRS9GLElBQUksQ0FBQyxXQUFXLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQy9CLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFM0MscURBQXFEO1FBQ3JELElBQUksQ0FBQyxPQUFPLFNBQUcsS0FBSyxDQUFDLFNBQVMsQ0FBQyxPQUFPLG1DQUFJLEVBQUUsQ0FBQztRQUU3QyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDdEIsQ0FBQztJQUVEOztTQUVLO0lBQ0UsWUFBWTtRQUNqQixNQUFNLFVBQVUsR0FBRyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUN6QyxNQUFNLGdCQUFnQixHQUFHLGdCQUFTLENBQUMscUJBQXFCLENBQUMsQ0FBQztRQUMxRCxJQUFJLEVBQUUsQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLENBQUMsRUFBRTtZQUNuQyxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLGdCQUFnQixDQUFDLENBQUM7WUFDL0MsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTtnQkFDbkIsMkNBQTJDO2dCQUMzQyxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUMzQixJQUFJLFFBQVEsR0FBVyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQy9CLElBQUksU0FBUyxHQUFXLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDaEMsSUFBSSxZQUFZLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsc0JBQXNCO2dCQUVsRCxvRUFBb0U7Z0JBQ3BFLHlFQUF5RTtnQkFDekUseUJBQXlCO2dCQUN6QixJQUFJLFlBQVksR0FBRyxHQUFHLFFBQVEsR0FBRyxTQUFTLEVBQUUsQ0FBQztnQkFDN0MsSUFBSSxVQUFVLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRTtvQkFDckMsWUFBWSxHQUFHLFNBQVMsQ0FBQztpQkFDMUI7Z0JBRUQsSUFBSSxRQUFRLEdBQUcsZ0JBQVMsQ0FBQyxHQUFHLGdCQUFnQixJQUFJLElBQUksRUFBRSxDQUFDLENBQUM7Z0JBRXhELElBQUksVUFBVSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLGFBQWEsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxFQUFFO29CQUNqSCxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsRUFBRTt3QkFDakMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsR0FBRzs0QkFDN0IsUUFBUSxFQUFFLFFBQVE7NEJBQ2xCLFNBQVMsRUFBRSxTQUFTO3lCQUNyQixDQUFDO3FCQUNIO29CQUVELElBQUksWUFBWSxLQUFLLEtBQUssRUFBRTt3QkFDMUIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxzQkFBc0IsR0FBRyxRQUFRLENBQUM7cUJBQ2hFO3lCQUFNLElBQUksWUFBWSxLQUFLLEtBQUssRUFBRTt3QkFDakMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQyx1QkFBdUIsR0FBRyxRQUFRLENBQUM7cUJBQ2pFO2lCQUNGO3FCQUFNLElBQUksSUFBSSxDQUFDLGNBQWMsQ0FBQyxRQUFRLEVBQUUsU0FBUyxDQUFDLEVBQUU7b0JBQ25ELElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxFQUFFO3dCQUNqQyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxHQUFHOzRCQUM3QixRQUFRLEVBQUUsUUFBUTs0QkFDbEIsU0FBUyxFQUFFLFNBQVM7eUJBQ3JCLENBQUM7cUJBQ0g7b0JBRUQsSUFBSSxZQUFZLEtBQUssS0FBSyxFQUFFO3dCQUMxQixJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDLHNCQUFzQixHQUFHLFFBQVEsQ0FBQztxQkFDaEU7eUJBQU0sSUFBSSxZQUFZLEtBQUssS0FBSyxFQUFFO3dCQUNqQyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDLHVCQUF1QixHQUFHLFFBQVEsQ0FBQztxQkFDakU7aUJBQ0Y7cUJBQU0sRUFBRSxnQkFBZ0I7b0JBQ3ZCLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRTt3QkFDdkIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEdBQUcsRUFBRSxDQUFDO3FCQUN6QjtvQkFDRCxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUU7d0JBQ3JDLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxHQUFHOzRCQUNqQyxRQUFRLEVBQUUsUUFBUTs0QkFDbEIsU0FBUyxFQUFFLFNBQVM7NEJBQ3BCLFNBQVMsRUFBRSxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsRUFBRSxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO3lCQUNsRSxDQUFDO3FCQUNIO29CQUVELElBQUksWUFBWSxLQUFLLEtBQUssRUFBRTt3QkFDMUIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDLENBQUMsc0JBQXNCLEdBQUcsUUFBUSxDQUFDO3FCQUNwRTt5QkFBTSxJQUFJLFlBQVksS0FBSyxLQUFLLEVBQUU7d0JBQ2pDLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDLHVCQUF1QixHQUFHLFFBQVEsQ0FBQztxQkFDckU7aUJBQ0Y7WUFDSCxDQUFDLENBQUMsQ0FBQztTQUNKO1FBRUQsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO0lBQ3hCLENBQUM7SUFFRDs7OztPQUlHO0lBRUssY0FBYyxDQUFDLFFBQWdCLEVBQUUsU0FBaUI7UUFDeEQsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsYUFBYTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBRTlDLEtBQUssTUFBTSxRQUFRLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxhQUFhLEVBQUU7WUFDakQsS0FBSyxNQUFNLFFBQVEsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsRUFBRTtnQkFDM0QsSUFBSSxRQUFRLENBQUMsUUFBUSxLQUFLLFFBQVEsSUFBSSxRQUFRLENBQUMsU0FBUyxLQUFLLFNBQVM7b0JBQUUsT0FBTyxJQUFJLENBQUM7YUFDckY7U0FDRjtRQUVELE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUVEOzs7U0FHSztJQUNHLFdBQVcsQ0FBQyxNQUFXO1FBQzdCLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsRUFBRTtZQUNuQyxFQUFFLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztTQUMvQjtRQUVELEVBQUUsQ0FBQyxhQUFhLENBQUMsR0FBRyxJQUFJLENBQUMsVUFBVSxpQkFBaUIsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUNoRSxDQUFDO0lBRUQ7OztTQUdLO0lBQ0csb0JBQW9CLENBQUMsU0FBYztRQUN6QyxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUU7WUFDbkMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7U0FDL0I7UUFFRCxNQUFNLGtCQUFrQixHQUFHLGdCQUFTLENBQUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxZQUFZLENBQUMsQ0FBQztRQUNyRSxJQUFJLEVBQUUsQ0FBQyxVQUFVLENBQUMsa0JBQWtCLENBQUMsRUFBRTtZQUNyQyxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLGtCQUFrQixDQUFDLENBQUM7WUFDakQsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsa0JBQWtCLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDdEUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1NBQ2xDO1FBRUQsSUFBSSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsa0JBQWtCLENBQUMsRUFBRTtZQUN0QyxFQUFFLENBQUMsU0FBUyxDQUFDLGtCQUFrQixDQUFDLENBQUM7U0FDbEM7UUFFRCxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQVEsRUFBRSxFQUFFO1lBQzFDLE1BQU0sUUFBUSxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNoQyxNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztZQUN6QyxNQUFNLGdCQUFnQixHQUFHLGdCQUFTLENBQUMsR0FBRyxrQkFBa0IsSUFBSSxRQUFRLEVBQUUsQ0FBQyxDQUFDO1lBQ3hFLEVBQUUsQ0FBQyxhQUFhLENBQUMsZ0JBQWdCLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDL0MsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7O1FBRUk7SUFDSSxjQUFjLENBQUMsYUFBcUIsV0FBVztRQUNyRCw0RkFBNEY7UUFDNUYsSUFBSSxNQUFNLEdBQW9CO1lBQzVCLE9BQU8sRUFBRSxvREFBeUI7WUFDbEMsY0FBYyxFQUFFO2dCQUNkLE9BQU8sRUFBRTtvQkFDUCxlQUFlLDJDQUFnQztvQkFDL0MsaUJBQWlCLEVBQUUsU0FBUztpQkFDN0I7YUFDRjtTQUNGLENBQUM7UUFFRixNQUFNLFNBQVMsR0FBRyxXQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFFMUQsSUFBSTtZQUNGLE1BQU0sVUFBVSxHQUFHLFdBQUksQ0FBQyxTQUFTLEVBQUUscURBQTBCLENBQUMsQ0FBQztZQUMvRCxNQUFNLFlBQVksR0FBRyxFQUFFLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1lBQy9DLElBQUksWUFBWSxFQUFFO2dCQUNoQixNQUFNLFNBQVMsR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUM5QyxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQzthQUMzQztZQUVELE9BQU8sTUFBeUIsQ0FBQztTQUNsQztRQUFDLE9BQU8sR0FBRyxFQUFFO1lBQ1osT0FBTyxNQUFNLENBQUM7U0FDZjtJQUNILENBQUM7Q0FDRjtBQTNQRCw4Q0EyUEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgeyBub3JtYWxpemUsIGpvaW4gfSBmcm9tICdwYXRoJztcbmltcG9ydCB7IE1vZGVsQXV0aFRyYW5zZm9ybWVyLCBNb2RlbEF1dGhUcmFuc2Zvcm1lckNvbmZpZyB9IGZyb20gJ2dyYXBocWwtYXV0aC10cmFuc2Zvcm1lcic7XG5pbXBvcnQgeyBNb2RlbENvbm5lY3Rpb25UcmFuc2Zvcm1lciB9IGZyb20gJ2dyYXBocWwtY29ubmVjdGlvbi10cmFuc2Zvcm1lcic7XG5pbXBvcnQgeyBEeW5hbW9EQk1vZGVsVHJhbnNmb3JtZXIgfSBmcm9tICdncmFwaHFsLWR5bmFtb2RiLXRyYW5zZm9ybWVyJztcbmltcG9ydCB7IEh0dHBUcmFuc2Zvcm1lciB9IGZyb20gJ2dyYXBocWwtaHR0cC10cmFuc2Zvcm1lcic7XG5pbXBvcnQgeyBLZXlUcmFuc2Zvcm1lciB9IGZyb20gJ2dyYXBocWwta2V5LXRyYW5zZm9ybWVyJztcbmltcG9ydCB7IEdyYXBoUUxUcmFuc2Zvcm0sIFRyYW5zZm9ybUNvbmZpZywgVFJBTlNGT1JNX0NVUlJFTlRfVkVSU0lPTiwgVFJBTlNGT1JNX0NPTkZJR19GSUxFX05BTUUsIENvbmZsaWN0SGFuZGxlclR5cGUsIElUcmFuc2Zvcm1lciB9IGZyb20gJ2dyYXBocWwtdHJhbnNmb3JtZXItY29yZSc7XG5pbXBvcnQgVHRsVHJhbnNmb3JtZXIgZnJvbSAnZ3JhcGhxbC10dGwtdHJhbnNmb3JtZXInO1xuaW1wb3J0IHsgVmVyc2lvbmVkTW9kZWxUcmFuc2Zvcm1lciB9IGZyb20gJ2dyYXBocWwtdmVyc2lvbmVkLXRyYW5zZm9ybWVyJztcblxuaW1wb3J0IHtcbiAgQ2RrVHJhbnNmb3JtZXIsXG4gIENka1RyYW5zZm9ybWVyVGFibGUsXG4gIENka1RyYW5zZm9ybWVyUmVzb2x2ZXIsXG4gIENka1RyYW5zZm9ybWVyRnVuY3Rpb25SZXNvbHZlcixcbiAgQ2RrVHJhbnNmb3JtZXJIdHRwUmVzb2x2ZXIsXG59IGZyb20gJy4vY2RrLXRyYW5zZm9ybWVyJztcblxuLy8gUmVidWlsdCB0aGlzIGZyb20gY2xvdWRmb3JtLXR5cGVzIGJlY2F1c2UgaXQgaGFzIHR5cGUgZXJyb3JzXG5pbXBvcnQgeyBSZXNvdXJjZSB9IGZyb20gJy4vcmVzb3VyY2UnO1xuXG4vLyBJbXBvcnQgdGhpcyB3YXkgYmVjYXVzZSBGdW5jdGlvblRyYW5zZm9ybWVyLmQudHMgdHlwZXMgd2VyZSB0aHJvd2luZyBhbiBlcm9yLiBBbmQgd2UgZGlkbid0IHdyaXRlIHRoaXMgcGFja2FnZSBzbyBob3BlIGZvciB0aGUgYmVzdCA6UFxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lXG5jb25zdCB7IEZ1bmN0aW9uVHJhbnNmb3JtZXIgfSA9IHJlcXVpcmUoJ2dyYXBocWwtZnVuY3Rpb24tdHJhbnNmb3JtZXInKTtcblxuZXhwb3J0IGludGVyZmFjZSBTY2hlbWFUcmFuc2Zvcm1lclByb3BzIHtcbiAgLyoqXG4gICAqIEZpbGUgcGF0aCB0byB0aGUgZ3JhcGhxbCBzY2hlbWFcbiAgICogQGRlZmF1bHQgc2NoZW1hLmdyYXBocWxcbiAgICovXG4gIHJlYWRvbmx5IHNjaGVtYVBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBhdGggd2hlcmUgdHJhbnNmb3JtZWQgc2NoZW1hIGFuZCByZXNvbHZlcnMgd2lsbCBiZSBwbGFjZWRcbiAgICogQGRlZmF1bHQgYXBwc3luY1xuICAgKi9cbiAgcmVhZG9ubHkgb3V0cHV0UGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogU2V0IGRlbGV0aW9uIHByb3RlY3Rpb24gb24gRHluYW1vREIgdGFibGVzXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGRlbGV0aW9uUHJvdGVjdGlvbkVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGVuYWJsZSBEYXRhU3RvcmUgb3Igbm90XG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBzeW5jRW5hYmxlZD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2NoZW1hVHJhbnNmb3JtZXJPdXRwdXRzIHtcbiAgcmVhZG9ubHkgY2RrVGFibGVzPzogeyBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJUYWJsZSB9O1xuICByZWFkb25seSBub25lUmVzb2x2ZXJzPzogeyBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJSZXNvbHZlciB9O1xuICByZWFkb25seSBmdW5jdGlvblJlc29sdmVycz86IHsgW25hbWU6IHN0cmluZ106IENka1RyYW5zZm9ybWVyRnVuY3Rpb25SZXNvbHZlcltdIH07XG4gIHJlYWRvbmx5IGh0dHBSZXNvbHZlcnM/OiB7IFtuYW1lOiBzdHJpbmddOiBDZGtUcmFuc2Zvcm1lckh0dHBSZXNvbHZlcltdIH07XG4gIHJlYWRvbmx5IHF1ZXJpZXM/OiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfTtcbiAgcmVhZG9ubHkgbXV0YXRpb25zPzogeyBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJSZXNvbHZlciB9O1xuICByZWFkb25seSBzdWJzY3JpcHRpb25zPzogeyBbbmFtZTogc3RyaW5nXTogQ2RrVHJhbnNmb3JtZXJSZXNvbHZlciB9O1xufVxuXG5leHBvcnQgY2xhc3MgU2NoZW1hVHJhbnNmb3JtZXIge1xuICBwdWJsaWMgcmVhZG9ubHkgc2NoZW1hUGF0aDogc3RyaW5nXG4gIHB1YmxpYyByZWFkb25seSBvdXRwdXRQYXRoOiBzdHJpbmdcbiAgcHVibGljIHJlYWRvbmx5IGlzU3luY0VuYWJsZWQ6IGJvb2xlYW5cblxuICBwcml2YXRlIHJlYWRvbmx5IGF1dGhUcmFuc2Zvcm1lckNvbmZpZzogTW9kZWxBdXRoVHJhbnNmb3JtZXJDb25maWdcblxuICBvdXRwdXRzOiBTY2hlbWFUcmFuc2Zvcm1lck91dHB1dHNcbiAgcmVzb2x2ZXJzOiBhbnlcbiAgYXV0aFJvbGVQb2xpY3k6IFJlc291cmNlIHwgdW5kZWZpbmVkXG4gIHVuYXV0aFJvbGVQb2xpY3k6IFJlc291cmNlIHwgdW5kZWZpbmVkXG5cbiAgY29uc3RydWN0b3IocHJvcHM6IFNjaGVtYVRyYW5zZm9ybWVyUHJvcHMpIHtcbiAgICB0aGlzLnNjaGVtYVBhdGggPSBwcm9wcy5zY2hlbWFQYXRoIHx8ICcuL3NjaGVtYS5ncmFwaHFsJztcbiAgICB0aGlzLm91dHB1dFBhdGggPSBwcm9wcy5vdXRwdXRQYXRoIHx8ICcuL2FwcHN5bmMnO1xuICAgIHRoaXMuaXNTeW5jRW5hYmxlZCA9IHByb3BzLnN5bmNFbmFibGVkIHx8IGZhbHNlO1xuXG4gICAgdGhpcy5vdXRwdXRzID0ge307XG4gICAgdGhpcy5yZXNvbHZlcnMgPSB7fTtcblxuICAgIC8vIFRPRE86IE1ha2UgdGhpcyBiZXR0ZXI/XG4gICAgdGhpcy5hdXRoVHJhbnNmb3JtZXJDb25maWcgPSB7XG4gICAgICBhdXRoQ29uZmlnOiB7XG4gICAgICAgIGRlZmF1bHRBdXRoZW50aWNhdGlvbjoge1xuICAgICAgICAgIGF1dGhlbnRpY2F0aW9uVHlwZTogJ0FNQVpPTl9DT0dOSVRPX1VTRVJfUE9PTFMnLFxuICAgICAgICAgIHVzZXJQb29sQ29uZmlnOiB7XG4gICAgICAgICAgICB1c2VyUG9vbElkOiAnMTIzNDV4eXonLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxBdXRoZW50aWNhdGlvblByb3ZpZGVyczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGF1dGhlbnRpY2F0aW9uVHlwZTogJ0FQSV9LRVknLFxuICAgICAgICAgICAgYXBpS2V5Q29uZmlnOiB7XG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVGVzdGluZycsXG4gICAgICAgICAgICAgIGFwaUtleUV4cGlyYXRpb25EYXlzOiAxMDAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgYXV0aGVudGljYXRpb25UeXBlOiAnQVdTX0lBTScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhdXRoZW50aWNhdGlvblR5cGU6ICdPUEVOSURfQ09OTkVDVCcsXG4gICAgICAgICAgICBvcGVuSURDb25uZWN0Q29uZmlnOiB7XG4gICAgICAgICAgICAgIG5hbWU6ICdPSURDJyxcbiAgICAgICAgICAgICAgaXNzdWVyVXJsOiAnaHR0cHM6Ly9jb2duaXRvLWlkcC51cy1lYXN0LTEuYW1hem9uYXdzLmNvbS91cy1lYXN0LTFfWFhYJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIHB1YmxpYyB0cmFuc2Zvcm0ocHJlQ2RrVHJhbnNmb3JtZXJzOiBJVHJhbnNmb3JtZXJbXSA9IFtdLCBwb3N0Q2RrVHJhbnNmb3JtZXJzOiBJVHJhbnNmb3JtZXJbXSA9IFtdKSB7XG4gICAgY29uc3QgdHJhbnNmb3JtQ29uZmlnID0gdGhpcy5pc1N5bmNFbmFibGVkID8gdGhpcy5sb2FkQ29uZmlnU3luYygpIDoge307XG5cbiAgICAvLyBOb3RlOiBUaGlzIGlzIG5vdCBleGFjdCBhcyB3ZSBhcmUgb21pdHRpbmcgdGhlIEBzZWFyY2hhYmxlIHRyYW5zZm9ybWVyIGFzIHdlbGwgYXMgc29tZSBvdGhlcnMuXG4gICAgY29uc3QgdHJhbnNmb3JtZXIgPSBuZXcgR3JhcGhRTFRyYW5zZm9ybSh7XG4gICAgICB0cmFuc2Zvcm1Db25maWc6IHRyYW5zZm9ybUNvbmZpZyxcbiAgICAgIHRyYW5zZm9ybWVyczogW1xuICAgICAgICBuZXcgRHluYW1vREJNb2RlbFRyYW5zZm9ybWVyKCksXG4gICAgICAgIG5ldyBUdGxUcmFuc2Zvcm1lcigpLFxuICAgICAgICBuZXcgVmVyc2lvbmVkTW9kZWxUcmFuc2Zvcm1lcigpLFxuICAgICAgICBuZXcgRnVuY3Rpb25UcmFuc2Zvcm1lcigpLFxuICAgICAgICBuZXcgS2V5VHJhbnNmb3JtZXIoKSxcbiAgICAgICAgbmV3IE1vZGVsQ29ubmVjdGlvblRyYW5zZm9ybWVyKCksXG4gICAgICAgIG5ldyBNb2RlbEF1dGhUcmFuc2Zvcm1lcih0aGlzLmF1dGhUcmFuc2Zvcm1lckNvbmZpZyksXG4gICAgICAgIG5ldyBIdHRwVHJhbnNmb3JtZXIoKSxcbiAgICAgICAgLi4ucHJlQ2RrVHJhbnNmb3JtZXJzLFxuICAgICAgICBuZXcgQ2RrVHJhbnNmb3JtZXIoKSxcbiAgICAgICAgLi4ucG9zdENka1RyYW5zZm9ybWVycyxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2hlbWEgPSBmcy5yZWFkRmlsZVN5bmModGhpcy5zY2hlbWFQYXRoKTtcbiAgICBjb25zdCBjZmRvYyA9IHRyYW5zZm9ybWVyLnRyYW5zZm9ybShzY2hlbWEudG9TdHJpbmcoKSk7XG5cbiAgICAvLyBUT0RPOiBHZXQgVW5hdXRoIFJvbGUgYW5kIEF1dGggUm9sZSBwb2xpY2llcyBmb3IgYXV0aG9yaXphdGlvbiBzdHVmZlxuICAgIHRoaXMudW5hdXRoUm9sZVBvbGljeSA9IGNmZG9jLnJvb3RTdGFjay5SZXNvdXJjZXM/LlVuYXV0aFJvbGVQb2xpY3kwMSBhcyBSZXNvdXJjZSB8fCB1bmRlZmluZWQ7XG5cbiAgICB0aGlzLndyaXRlU2NoZW1hKGNmZG9jLnNjaGVtYSk7XG4gICAgdGhpcy53cml0ZVJlc29sdmVyc1RvRmlsZShjZmRvYy5yZXNvbHZlcnMpO1xuXG4gICAgLy8gT3V0cHV0cyBzaG91bGRuJ3QgYmUgbnVsbCBidXQgZGVmYXVsdCB0byBlbXB0eSBtYXBcbiAgICB0aGlzLm91dHB1dHMgPSBjZmRvYy5yb290U3RhY2suT3V0cHV0cyA/PyB7fTtcblxuICAgIHJldHVybiB0aGlzLm91dHB1dHM7XG4gIH1cblxuICAvKipcbiAgICAgKlxuICAgICAqL1xuICBwdWJsaWMgZ2V0UmVzb2x2ZXJzKCkge1xuICAgIGNvbnN0IHN0YXRlbWVudHMgPSBbJ1F1ZXJ5JywgJ011dGF0aW9uJ107XG4gICAgY29uc3QgcmVzb2x2ZXJzRGlyUGF0aCA9IG5vcm1hbGl6ZSgnLi9hcHBzeW5jL3Jlc29sdmVycycpO1xuICAgIGlmIChmcy5leGlzdHNTeW5jKHJlc29sdmVyc0RpclBhdGgpKSB7XG4gICAgICBjb25zdCBmaWxlcyA9IGZzLnJlYWRkaXJTeW5jKHJlc29sdmVyc0RpclBhdGgpO1xuICAgICAgZmlsZXMuZm9yRWFjaChmaWxlID0+IHtcbiAgICAgICAgLy8gRXhhbXBsZTogTXV0YXRpb24uY3JlYXRlQ2hhbm5lbC5yZXNwb25zZVxuICAgICAgICBsZXQgYXJncyA9IGZpbGUuc3BsaXQoJy4nKTtcbiAgICAgICAgbGV0IHR5cGVOYW1lOiBzdHJpbmcgPSBhcmdzWzBdO1xuICAgICAgICBsZXQgZmllbGROYW1lOiBzdHJpbmcgPSBhcmdzWzFdO1xuICAgICAgICBsZXQgdGVtcGxhdGVUeXBlID0gYXJnc1syXTsgLy8gcmVxdWVzdCBvciByZXNwb25zZVxuXG4gICAgICAgIC8vIGRlZmF1bHQgdG8gY29tcG9zaXRlIGtleSBvZiB0eXBlTmFtZSBhbmQgZmllbGROYW1lLCBob3dldmVyIGlmIGl0XG4gICAgICAgIC8vIGlzIFF1ZXJ5LCBNdXRhdGlvbiBvciBTdWJzY3JpcHRpb24gKHRvcCBsZXZlbCkgdGhlIGNvbXBvc2l0ZUtleSBpcyB0aGVcbiAgICAgICAgLy8gc2FtZSBhcyBmaWVsZE5hbWUgb25seVxuICAgICAgICBsZXQgY29tcG9zaXRlS2V5ID0gYCR7dHlwZU5hbWV9JHtmaWVsZE5hbWV9YDtcbiAgICAgICAgaWYgKHN0YXRlbWVudHMuaW5kZXhPZih0eXBlTmFtZSkgPj0gMCkge1xuICAgICAgICAgIGNvbXBvc2l0ZUtleSA9IGZpZWxkTmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmaWxlcGF0aCA9IG5vcm1hbGl6ZShgJHtyZXNvbHZlcnNEaXJQYXRofS8ke2ZpbGV9YCk7XG5cbiAgICAgICAgaWYgKHN0YXRlbWVudHMuaW5kZXhPZih0eXBlTmFtZSkgPj0gMCB8fCAodGhpcy5vdXRwdXRzLm5vbmVSZXNvbHZlcnMgJiYgdGhpcy5vdXRwdXRzLm5vbmVSZXNvbHZlcnNbY29tcG9zaXRlS2V5XSkpIHtcbiAgICAgICAgICBpZiAoIXRoaXMucmVzb2x2ZXJzW2NvbXBvc2l0ZUtleV0pIHtcbiAgICAgICAgICAgIHRoaXMucmVzb2x2ZXJzW2NvbXBvc2l0ZUtleV0gPSB7XG4gICAgICAgICAgICAgIHR5cGVOYW1lOiB0eXBlTmFtZSxcbiAgICAgICAgICAgICAgZmllbGROYW1lOiBmaWVsZE5hbWUsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmICh0ZW1wbGF0ZVR5cGUgPT09ICdyZXEnKSB7XG4gICAgICAgICAgICB0aGlzLnJlc29sdmVyc1tjb21wb3NpdGVLZXldLnJlcXVlc3RNYXBwaW5nVGVtcGxhdGUgPSBmaWxlcGF0aDtcbiAgICAgICAgICB9IGVsc2UgaWYgKHRlbXBsYXRlVHlwZSA9PT0gJ3JlcycpIHtcbiAgICAgICAgICAgIHRoaXMucmVzb2x2ZXJzW2NvbXBvc2l0ZUtleV0ucmVzcG9uc2VNYXBwaW5nVGVtcGxhdGUgPSBmaWxlcGF0aDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy5pc0h0dHBSZXNvbHZlcih0eXBlTmFtZSwgZmllbGROYW1lKSkge1xuICAgICAgICAgIGlmICghdGhpcy5yZXNvbHZlcnNbY29tcG9zaXRlS2V5XSkge1xuICAgICAgICAgICAgdGhpcy5yZXNvbHZlcnNbY29tcG9zaXRlS2V5XSA9IHtcbiAgICAgICAgICAgICAgdHlwZU5hbWU6IHR5cGVOYW1lLFxuICAgICAgICAgICAgICBmaWVsZE5hbWU6IGZpZWxkTmFtZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHRlbXBsYXRlVHlwZSA9PT0gJ3JlcScpIHtcbiAgICAgICAgICAgIHRoaXMucmVzb2x2ZXJzW2NvbXBvc2l0ZUtleV0ucmVxdWVzdE1hcHBpbmdUZW1wbGF0ZSA9IGZpbGVwYXRoO1xuICAgICAgICAgIH0gZWxzZSBpZiAodGVtcGxhdGVUeXBlID09PSAncmVzJykge1xuICAgICAgICAgICAgdGhpcy5yZXNvbHZlcnNbY29tcG9zaXRlS2V5XS5yZXNwb25zZU1hcHBpbmdUZW1wbGF0ZSA9IGZpbGVwYXRoO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHsgLy8gVGhpcyBpcyBhIEdTSVxuICAgICAgICAgIGlmICghdGhpcy5yZXNvbHZlcnMuZ3NpKSB7XG4gICAgICAgICAgICB0aGlzLnJlc29sdmVycy5nc2kgPSB7fTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKCF0aGlzLnJlc29sdmVycy5nc2lbY29tcG9zaXRlS2V5XSkge1xuICAgICAgICAgICAgdGhpcy5yZXNvbHZlcnMuZ3NpW2NvbXBvc2l0ZUtleV0gPSB7XG4gICAgICAgICAgICAgIHR5cGVOYW1lOiB0eXBlTmFtZSxcbiAgICAgICAgICAgICAgZmllbGROYW1lOiBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgIHRhYmxlTmFtZTogZmllbGROYW1lLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgZmllbGROYW1lLnNsaWNlKDEpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAodGVtcGxhdGVUeXBlID09PSAncmVxJykge1xuICAgICAgICAgICAgdGhpcy5yZXNvbHZlcnMuZ3NpW2NvbXBvc2l0ZUtleV0ucmVxdWVzdE1hcHBpbmdUZW1wbGF0ZSA9IGZpbGVwYXRoO1xuICAgICAgICAgIH0gZWxzZSBpZiAodGVtcGxhdGVUeXBlID09PSAncmVzJykge1xuICAgICAgICAgICAgdGhpcy5yZXNvbHZlcnMuZ3NpW2NvbXBvc2l0ZUtleV0ucmVzcG9uc2VNYXBwaW5nVGVtcGxhdGUgPSBmaWxlcGF0aDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLnJlc29sdmVycztcbiAgfVxuXG4gIC8qKlxuICAgKiBkZWNpZGVzIGlmIHRoaXMgaXMgYSByZXNvbHZlciBmb3IgYW4gSFRUUCBkYXRhc291cmNlXG4gICAqIEBwYXJhbSB0eXBlTmFtZVxuICAgKiBAcGFyYW0gZmllbGROYW1lXG4gICAqL1xuXG4gIHByaXZhdGUgaXNIdHRwUmVzb2x2ZXIodHlwZU5hbWU6IHN0cmluZywgZmllbGROYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAoIXRoaXMub3V0cHV0cy5odHRwUmVzb2x2ZXJzKSByZXR1cm4gZmFsc2U7XG5cbiAgICBmb3IgKGNvbnN0IGVuZHBvaW50IGluIHRoaXMub3V0cHV0cy5odHRwUmVzb2x2ZXJzKSB7XG4gICAgICBmb3IgKGNvbnN0IHJlc29sdmVyIG9mIHRoaXMub3V0cHV0cy5odHRwUmVzb2x2ZXJzW2VuZHBvaW50XSkge1xuICAgICAgICBpZiAocmVzb2x2ZXIudHlwZU5hbWUgPT09IHR5cGVOYW1lICYmIHJlc29sdmVyLmZpZWxkTmFtZSA9PT0gZmllbGROYW1lKSByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvKipcbiAgICAgKiBXcml0ZXMgdGhlIHNjaGVtYSB0byB0aGUgb3V0cHV0IGRpcmVjdG9yeSBmb3IgdXNlIHdpdGggQGF3cy1jZGsvYXdzLWFwcHN5bmNcbiAgICAgKiBAcGFyYW0gc2NoZW1hXG4gICAgICovXG4gIHByaXZhdGUgd3JpdGVTY2hlbWEoc2NoZW1hOiBhbnkpIHtcbiAgICBpZiAoIWZzLmV4aXN0c1N5bmModGhpcy5vdXRwdXRQYXRoKSkge1xuICAgICAgZnMubWtkaXJTeW5jKHRoaXMub3V0cHV0UGF0aCk7XG4gICAgfVxuXG4gICAgZnMud3JpdGVGaWxlU3luYyhgJHt0aGlzLm91dHB1dFBhdGh9L3NjaGVtYS5ncmFwaHFsYCwgc2NoZW1hKTtcbiAgfVxuXG4gIC8qKlxuICAgICAqIFdyaXRlcyBhbGwgdGhlIHJlc29sdmVycyB0byB0aGUgb3V0cHV0IGRpcmVjdG9yeSBmb3IgbG9hZGluZyBpbnRvIHRoZSBkYXRhc291cmNlcyBsYXRlclxuICAgICAqIEBwYXJhbSByZXNvbHZlcnNcbiAgICAgKi9cbiAgcHJpdmF0ZSB3cml0ZVJlc29sdmVyc1RvRmlsZShyZXNvbHZlcnM6IGFueSkge1xuICAgIGlmICghZnMuZXhpc3RzU3luYyh0aGlzLm91dHB1dFBhdGgpKSB7XG4gICAgICBmcy5ta2RpclN5bmModGhpcy5vdXRwdXRQYXRoKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXNvbHZlckZvbGRlclBhdGggPSBub3JtYWxpemUodGhpcy5vdXRwdXRQYXRoICsgJy9yZXNvbHZlcnMnKTtcbiAgICBpZiAoZnMuZXhpc3RzU3luYyhyZXNvbHZlckZvbGRlclBhdGgpKSB7XG4gICAgICBjb25zdCBmaWxlcyA9IGZzLnJlYWRkaXJTeW5jKHJlc29sdmVyRm9sZGVyUGF0aCk7XG4gICAgICBmaWxlcy5mb3JFYWNoKGZpbGUgPT4gZnMudW5saW5rU3luYyhyZXNvbHZlckZvbGRlclBhdGggKyAnLycgKyBmaWxlKSk7XG4gICAgICBmcy5ybWRpclN5bmMocmVzb2x2ZXJGb2xkZXJQYXRoKTtcbiAgICB9XG5cbiAgICBpZiAoIWZzLmV4aXN0c1N5bmMocmVzb2x2ZXJGb2xkZXJQYXRoKSkge1xuICAgICAgZnMubWtkaXJTeW5jKHJlc29sdmVyRm9sZGVyUGF0aCk7XG4gICAgfVxuXG4gICAgT2JqZWN0LmtleXMocmVzb2x2ZXJzKS5mb3JFYWNoKChrZXk6IGFueSkgPT4ge1xuICAgICAgY29uc3QgcmVzb2x2ZXIgPSByZXNvbHZlcnNba2V5XTtcbiAgICAgIGNvbnN0IGZpbGVOYW1lID0ga2V5LnJlcGxhY2UoJy52dGwnLCAnJyk7XG4gICAgICBjb25zdCByZXNvbHZlckZpbGVQYXRoID0gbm9ybWFsaXplKGAke3Jlc29sdmVyRm9sZGVyUGF0aH0vJHtmaWxlTmFtZX1gKTtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMocmVzb2x2ZXJGaWxlUGF0aCwgcmVzb2x2ZXIpO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAgICogQHJldHVybnMge0BsaW5rIFRyYW5zZm9ybUNvbmZpZ31cbiAgICAqL1xuICBwcml2YXRlIGxvYWRDb25maWdTeW5jKHByb2plY3REaXI6IHN0cmluZyA9ICdyZXNvdXJjZXMnKTogVHJhbnNmb3JtQ29uZmlnIHtcbiAgICAvLyBJbml0aWFsaXplIHRoZSBjb25maWcgYWx3YXlzIHdpdGggdGhlIGxhdGVzdCB2ZXJzaW9uLCBvdGhlciBtZW1iZXJzIGFyZSBvcHRpb25hbCBmb3Igbm93LlxuICAgIGxldCBjb25maWc6IFRyYW5zZm9ybUNvbmZpZyA9IHtcbiAgICAgIFZlcnNpb246IFRSQU5TRk9STV9DVVJSRU5UX1ZFUlNJT04sXG4gICAgICBSZXNvbHZlckNvbmZpZzoge1xuICAgICAgICBwcm9qZWN0OiB7XG4gICAgICAgICAgQ29uZmxpY3RIYW5kbGVyOiBDb25mbGljdEhhbmRsZXJUeXBlLk9QVElNSVNUSUMsXG4gICAgICAgICAgQ29uZmxpY3REZXRlY3Rpb246ICdWRVJTSU9OJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGNvbmZpZ0RpciA9IGpvaW4oX19kaXJuYW1lLCAnLi4nLCAnLi4nLCBwcm9qZWN0RGlyKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb25maWdQYXRoID0gam9pbihjb25maWdEaXIsIFRSQU5TRk9STV9DT05GSUdfRklMRV9OQU1FKTtcbiAgICAgIGNvbnN0IGNvbmZpZ0V4aXN0cyA9IGZzLmV4aXN0c1N5bmMoY29uZmlnUGF0aCk7XG4gICAgICBpZiAoY29uZmlnRXhpc3RzKSB7XG4gICAgICAgIGNvbnN0IGNvbmZpZ1N0ciA9IGZzLnJlYWRGaWxlU3luYyhjb25maWdQYXRoKTtcbiAgICAgICAgY29uZmlnID0gSlNPTi5wYXJzZShjb25maWdTdHIudG9TdHJpbmcoKSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBjb25maWcgYXMgVHJhbnNmb3JtQ29uZmlnO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIGNvbmZpZztcbiAgICB9XG4gIH1cbn1cbiJdfQ==