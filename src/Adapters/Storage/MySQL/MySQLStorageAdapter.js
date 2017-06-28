import Parse            from 'parse/node';
import _                from 'lodash';
import sql              from './sql';

const parser = require('./MySQLConfigParser');
const mysql = require('mysql2/promise');
const PostgresRelationDoesNotExistError = '42P01';
const MySQLRelationDoesNotExistError = 'ER_NO_SUCH_TABLE';
const PostgresDuplicateRelationError = '42P07';
const MySQLDuplicateColumnError = 'ER_DUP_FIELDNAME';
const PostgresDuplicateObjectError = '42710';
const MySQLDuplicateObjectError = 'ER_DUP_ENTRY';
const MySQLUniqueIndexViolationError = 'ER_DUP_KEYNAME';
const PostgresUniqueIndexViolationError = '23505';
const PostgresTransactionAbortedError = '25P02';
const logger = require('../../../logger');

const debug = function(){
  let args = [...arguments];
  args = ['PG: ' + arguments[0]].concat(args.slice(1, args.length));
  const log = logger.getLogger();
  log.debug.apply(log, args);
}

const parseTypeToPostgresType = type => {
  switch (type.type) {
  case 'String': return 'text';
  case 'Date': return 'timestamp';
  case 'Object': return 'json';
  case 'File': return 'text';
  case 'Boolean': return 'boolean';
  case 'Pointer': return 'char(10)';
  case 'Number': return 'double precision';
  case 'GeoPoint': return 'point';
  case 'Bytes': return 'json';
  case 'Array':
    if (type.contents && type.contents.type === 'String') {
      //return 'text[]';
      return 'json';
    } else {
      return 'json';
    }
  default: throw `no type for ${JSON.stringify(type)} yet`;
  }
};

const defaultUniqueKeyLength = 'varchar(120)';

const ParseToPosgresComparator = {
  '$gt': '>',
  '$lt': '<',
  '$gte': '>=',
  '$lte': '<='
}

const toPostgresValue = value => {
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      return new Date(value.iso).toISOString().slice(0, 19).replace('T', ' ')
    }
    if (value.__type === 'File') {
      return value.name;
    }
  }
  return value;
}

const transformValue = value => {
  if (typeof value === 'object' &&
        value.__type === 'Pointer') {
    return value.objectId;
  }
  return value;
}

// Duplicate from then mongo adapter...
const emptyCLPS = Object.freeze({
  find: {},
  get: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
});

const defaultCLPS = Object.freeze({
  find: {'*': true},
  get: {'*': true},
  create: {'*': true},
  update: {'*': true},
  delete: {'*': true},
  addField: {'*': true},
});

const toParseSchema = (schema) => {
  if (schema.className === '_User') {
    delete schema.fields._hashed_password;
  }
  if (schema.fields) {
    delete schema.fields._wperm;
    delete schema.fields._rperm;
  }
  let clps = defaultCLPS;
  if (schema.classLevelPermissions) {
    clps = {...emptyCLPS, ...schema.classLevelPermissions};
  }
  return {
    className: schema.className,
    fields: schema.fields,
    classLevelPermissions: clps,
  };
}

const toPostgresSchema = (schema) => {
  if (!schema) {
    return schema;
  }
  schema.fields = schema.fields || {};
  schema.fields._wperm = {type: 'Array', contents: {type: 'String'}}
  schema.fields._rperm = {type: 'Array', contents: {type: 'String'}}
  if (schema.className === '_User') {
    schema.fields._hashed_password = {type: 'String'};
    schema.fields._password_history = {type: 'Array'};
  }
  return schema;
}

const handleDotFields = (object) => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      object[first] = object[first] || {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];
      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      /* eslint-disable no-cond-assign */
      while(next = components.shift()) {
      /* eslint-enable no-cond-assign */
        currentObj[next] = currentObj[next] || {};
        if (components.length === 0) {
          currentObj[next] = value;
        }
        currentObj = currentObj[next];
      }
      delete object[fieldName];
    }
  });
  return object;
}

const validateKeys = (object) => {
  if (typeof object == 'object') {
    for (const key in object) {
      if (typeof object[key] == 'object') {
        validateKeys(object[key]);
      }

      if(key.includes('$') || key.includes('.')){
        throw new Parse.Error(Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
      }
    }
  }
}

// Returns the list of join tables on a schema
const joinTablesForSchema = (schema) => {
  const list = [];
  if (schema) {
    Object.keys(schema.fields).forEach((field) => {
      if (schema.fields[field].type === 'Relation') {
        list.push(`_Join:${field}:${schema.className}`);
      }
    });
  }
  return list;
}

const buildWhereClause = ({ schema, query, index }) => {
  const patterns = [];
  let values = [];
  const sorts = [];

  schema = toPostgresSchema(schema);
  for (const fieldName in query) {
    const isArrayField = schema.fields
          && schema.fields[fieldName]
          && schema.fields[fieldName].type === 'Array';
    const initialPatternsLength = patterns.length;
    const fieldValue = query[fieldName];

    // nothingin the schema, it's gonna blow up
    if (!schema.fields[fieldName]) {
      // as it won't exist
      if (fieldValue && fieldValue.$exists === false) {
        continue;
      }
    }

    if (fieldName.indexOf('.') >= 0) {
      const components = fieldName.split('.');
      let name;
      components.map((cmpt, index) => {
        if (index === 0) {
          name = `\`${cmpt}\`->>`;
        } else if (index === 1) {
          name += `'$.${cmpt}`;
        } else {
          name += `.${cmpt}`;
        }
      });
      name += "'";
      if (fieldValue === null) {
        patterns.push(`${name} IS NULL`);
      } else {
        patterns.push(`${name} = '${fieldValue}'`);
      }
    } else if (fieldValue === null) {
      patterns.push(`\`$${index}:name\` IS NULL`);
      values.push(fieldName);
      index += 1;
      continue;
    } else if (typeof fieldValue === 'string') {
      patterns.push(`$${index}:name = '$${index + 1}:name'`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'boolean') {
      patterns.push(`$${index}:name = $${index + 1}:name`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'number') {
      patterns.push(`$${index}:name = $${index + 1}:name`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (fieldName === '$or' || fieldName === '$and') {
      const clauses = [];
      const clauseValues = [];
      fieldValue.forEach((subQuery) =>  {
        const clause = buildWhereClause({ schema, query: subQuery, index });
        if (clause.pattern.length > 0) {
          clauses.push(clause.pattern);
          clauseValues.push(...clause.values);
          index += clause.values.length;
        }
      });
      const orOrAnd = fieldName === '$or' ? ' OR ' : ' AND ';
      patterns.push(`(${clauses.join(orOrAnd)})`);
      values.push(...clauseValues);
    }

    if (fieldValue.$ne !== undefined) {
      if (isArrayField) {
        fieldValue.$ne = JSON.stringify([fieldValue.$ne]);
        patterns.push(`JSON_CONTAINS(\`$${index}:name\`, '$${index + 1}:name') != 1`);
      } else {
        if (fieldValue.$ne === null) {
          patterns.push(`$${index}:name IS NOT NULL`);
          values.push(fieldName);
          index += 1;
          continue;
        } else {
          // if not null, we need to manually exclude null
          patterns.push(`($${index}:name <> '$${index + 1}:name' OR $${index}:name IS NULL)`);
        }
      }

      // TODO: support arrays
      values.push(fieldName, fieldValue.$ne);
      index += 2;
    }

    if (fieldValue.$eq) {
      patterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
      values.push(fieldName, fieldValue.$eq);
      index += 2;
    }
    const isInOrNin = Array.isArray(fieldValue.$in) || Array.isArray(fieldValue.$nin);
    if (Array.isArray(fieldValue.$in) &&
        isArrayField &&
        schema.fields[fieldName].contents &&
        schema.fields[fieldName].contents.type === 'String') {
      const inPatterns = [];
      let allowNull = false;
      values.push(fieldName);
      fieldValue.$in.forEach((listElem, listIndex) => {
        if (listElem === null) {
          allowNull = true;
        } else {
          values.push(listElem);
          inPatterns.push(`$${index + 1 + listIndex - (allowNull ? 1 : 0)}`);
        }
      });
      const tempInPattern = inPatterns.join(',');
      if (allowNull) {
        patterns.push(`($${index}:name IS NULL OR $${index}:name IS NOT NULL && JSON_ARRAY('${JSON.stringify(tempInPattern)}') <> JSON_ARRAY(''))`);
      } else {
        patterns.push(`$${index}:name && '${JSON.stringify(tempInPattern)}'`);
      }
      index = index + 1 + inPatterns.length;
    } else if (isInOrNin) {
      var createConstraint = (baseArray, notIn) => {
        if (baseArray.length > 0) {
          const not = notIn ? ' NOT ' : '';
          if (isArrayField) {
            const operator = notIn ? ' != ' : ' = ';
            patterns.push(`JSON_CONTAINS(\`$${index}:name\`, '$${index + 1}:name') ${operator} 1`);
            values.push(fieldName, JSON.stringify(baseArray));
            index += 2;
          } else {
            const inPatterns = [];
            values.push(fieldName);
            baseArray.forEach((listElem, listIndex) => {
              values.push(listElem);
              inPatterns.push(`'$${index + 1 + listIndex}:name'`);
            });
            patterns.push(`\`$${index}:name\` ${not} IN (${inPatterns.join(',')})`);
            index = index + 1 + inPatterns.length;
          }
        } else if (!notIn) {
          values.push(fieldName);
          patterns.push(`$${index}:name IS NULL`);
          index = index + 1;
        }
      }
      if (fieldValue.$in) {
        createConstraint(_.flatMap(fieldValue.$in, elt => elt), false);
      }
      if (fieldValue.$nin) {
        createConstraint(_.flatMap(fieldValue.$nin, elt => elt), true);
      }
    }

    if (Array.isArray(fieldValue.$all) && isArrayField) {
      patterns.push(`JSON_CONTAINS(\`$${index}:name\`, '$${index + 1}:name') = 1`);
      values.push(fieldName, JSON.stringify(fieldValue.$all));
      index += 2;
    }

    if (typeof fieldValue.$exists !== 'undefined') {
      if (fieldValue.$exists) {
        patterns.push(`$${index}:name IS NOT NULL`);
      } else {
        patterns.push(`$${index}:name IS NULL`);
      }
      values.push(fieldName);
      index += 1;
    }

    if (fieldValue.$text) {
      const search = fieldValue.$text.$search;
      let language = 'english';
      if (typeof search !== 'object') {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $search, should be object`
        );
      }
      if (!search.$term || typeof search.$term !== 'string') {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $term, should be string`
        );
      }
      if (search.$language && typeof search.$language !== 'string') {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $language, should be string`
        );
      } else if (search.$language) {
        language = search.$language;
      }
      if (search.$caseSensitive && typeof search.$caseSensitive !== 'boolean') {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $caseSensitive, should be boolean`
        );
      } else if (search.$caseSensitive) {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $caseSensitive not supported, please use $regex or create a separate lower case column.`
        );
      }
      if (search.$diacriticSensitive && typeof search.$diacriticSensitive !== 'boolean') {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $diacriticSensitive, should be boolean`
        );
      } else if (search.$diacriticSensitive === false) {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          `bad $text: $diacriticSensitive - false not supported, install Postgres Unaccent Extension`
        );
      }
      patterns.push(`to_tsvector($${index}:name, $${index + 1}:name) @@ to_tsquery($${index + 2}:name, $${index + 3}:name)`);
      values.push(language, fieldName, language, search.$term);
      index += 4;
    }

    if (fieldValue.$nearSphere) {
      const point = fieldValue.$nearSphere;
      const distance = fieldValue.$maxDistance;
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}:name`);
      sorts.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) ASC`)
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }

    if (fieldValue.$within && fieldValue.$within.$box) {
      const box = fieldValue.$within.$box;
      const left = box[0].longitude;
      const bottom = box[0].latitude;
      const right = box[1].longitude;
      const top = box[1].latitude;

      patterns.push(`$${index}:name::point <@ $${index + 1}::box`);
      values.push(fieldName, `((${left}, ${bottom}), (${right}, ${top}))`);
      index += 2;
    }

    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$polygon) {
      const polygon = fieldValue.$geoWithin.$polygon;
      if (!(polygon instanceof Array)) {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          'bad $geoWithin value; $polygon should contain at least 3 GeoPoints'
        );
      }
      if (polygon.length < 3) {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          'bad $geoWithin value; $polygon should contain at least 3 GeoPoints'
        );
      }
      const points = polygon.map((point) => {
        if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value');
        } else {
          Parse.GeoPoint._validate(point.latitude, point.longitude);
        }
        return `(${point.longitude}, ${point.latitude})`;
      }).join(', ');

      patterns.push(`$${index}:name::point <@ $${index + 1}::polygon`);
      values.push(fieldName, `(${points})`);
      index += 2;
    }

    if (fieldValue.$regex) {
      let regex = fieldValue.$regex;
      const operator = 'REGEXP';
      const opts = fieldValue.$options;
      if (opts) {
        // if (opts.indexOf('i') >= 0) {
        //   operator = '~*';
        // }
        if (opts.indexOf('x') >= 0) {
          regex = removeWhiteSpace(regex);
        }
      }

      regex = processRegexPattern(regex);

      patterns.push(`\`$${index}:name\` ${operator} '$${index + 1}:name'`);
      values.push(fieldName, regex);
      index += 2;
    }

    if (fieldValue.__type === 'Pointer') {
      if (isArrayField) {
        patterns.push(`JSON_CONTAINS(\`$${index}:name\`, '$${index + 1}:name') = 1`);
        values.push(fieldName, JSON.stringify([fieldValue]));
        index += 2;
      } else {
        patterns.push(`$${index}:name = '$${index + 1}:name'`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      }
    }

    if (fieldValue.__type === 'Date') {
      patterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
      values.push(fieldName, toPostgresValue(fieldValue));
      index += 2;
    }

    if (fieldValue.__type === 'GeoPoint') {
      patterns.push('$' + index + ':name ~= POINT($' + (index + 1) + ', $' + (index + 2) + ')');
      values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
      index += 3;
    }

    Object.keys(ParseToPosgresComparator).forEach(cmp => {
      if (fieldValue[cmp]) {
        const pgComparator = ParseToPosgresComparator[cmp];
        patterns.push(`\`$${index}:name\` ${pgComparator} '$${index + 1}:name'`);
        values.push(fieldName, toPostgresValue(fieldValue[cmp]));
        index += 2;
      }
    });

    if (initialPatternsLength === patterns.length) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, `Postgres doesn't support this query type yet ${JSON.stringify(fieldValue)}`);
    }
  }
  values = values.map(transformValue);
  return { pattern: patterns.join(' AND '), values, sorts };
}

export class MySQLStorageAdapter {
  // Private
  _collectionPrefix: string;
  _uri: string;
  _databaseOptions: Object;
  // Public
  connectionPromise;
  database;

  constructor({
    uri,
    collectionPrefix = '',
    databaseOptions = {},
  }) {
    this._uri = uri;
    this._collectionPrefix = collectionPrefix;
    let dbOptions = {};
    databaseOptions = databaseOptions || {};
    if (uri) {
      dbOptions = parser.getDatabaseOptionsFromURI(uri);
    }
    for (const key in databaseOptions) {
      dbOptions[key] = databaseOptions[key];
    }
    dbOptions['multipleStatements'] = true;
    dbOptions['queryFormat'] = function (query, values) {
      if (!values) return query;
      const maxVariable = 100000;
      const multipleValues = /\$([1-9][0-9]{0,16}(?![0-9])(\^|~|#|:raw|:alias|:name|:json|:csv|:value)?)/g;
      const validModifiers = /\^|~|#|:raw|:alias|:name|:json|:csv|:value/;
      const sql = query.replace(multipleValues, (name) => {
        const mod = name.substring(1).match(validModifiers);
        let idx = 100000;
        if (!mod) {
          idx = name.substring(1) - 1;
        } else {
          idx = name.substring(1).substring(0, mod.index) - 1;
        }
        if (idx >= maxVariable) {
          throw new Parse.Error('Variable $' + name.substring(1) + ' exceeds supported maximum of $' + maxVariable);
        }
        if (idx < values.length) {
          return values[idx];
        }
      });
      debug(sql);
      return sql;
    };
    this._databaseOptions = dbOptions;
  }

  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = mysql.createConnection(this._databaseOptions).then(database => {
      if (!database) {
        delete this.connectionPromise;
        return;
      }
      database.on('error', () => {
        delete this.connectionPromise;
      });
      database.on('close', () => {
        delete this.connectionPromise;
      });
      this.database = database;
    }).catch((err) => {
      delete this.connectionPromise;
      return Promise.reject(err);
    });

    return this.connectionPromise;
  }

  handleShutdown() {
    if (!this.database) {
      return;
    }
    this.database.end();
  }

  _ensureSchemaCollectionExists() {
    debug('_ensureSchemaCollectionExists');
    return this.connect()
      .then(() => this.database.query('CREATE TABLE IF NOT EXISTS `_SCHEMA` (`className` VARCHAR(120), `schema` JSON, `isParseClass` BOOL, PRIMARY KEY (`className`));'))
      .catch(error => {
        console.log('what did i do');
        console.log(error);
        if (error.code === PostgresDuplicateRelationError
          || error.code === PostgresUniqueIndexViolationError
          || error.code === PostgresDuplicateObjectError) {
        // Table already exists, must have been created by a different request. Ignore error.
          return;
        } else {
          throw error;
        }
      });
  }

  classExists(name) {
    const qs = 'SELECT EXISTS (SELECT 1 FROM `information_schema.tables` WHERE `table_name` = \'$1:name\')';
    return this.connect()
      .then(() => this.database.query(qs, [name]))
      .then((res) => res.exists)
      .catch(error => {
        console.log(error);
      });
  }

  setClassLevelPermissions(className, CLPs) {
    return this._ensureSchemaCollectionExists().then(() => {
      const values = [className, 'schema', 'classLevelPermissions', JSON.stringify(CLPs)]
      return this.database.query(`UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3:name, $4:name) WHERE "className"=$1 `, values);
    });
  }

  createClass(className, schema) {
    debug('createClass', className, schema);
    const qs = "INSERT INTO `_SCHEMA` (`className`, `schema`, `isParseClass`) VALUES ('$1:name', '$2:name', true)";
    return this.connect()
      .then(() => this.createTable(className, schema))
      .then(() => this.database.query(qs, [className, JSON.stringify(schema)]))
      .then(() => toParseSchema(schema))
      .catch((error) => {
        if (error.code === MySQLDuplicateObjectError && error.detail.includes(className)) {
          //SKIP
        } else if (error.code === PostgresDuplicateObjectError && error.detail.includes(className)) {
          throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, `Class ${className} already exists.`)
        } else {
          console.log('error here');
          throw error;
        }
      });
  }

  // Just create a table, do not insert in schema
  createTable(className, schema) {
    debug('createTable', className, schema);
    const valuesArray = [];
    const patternsArray = [];
    const fields = Object.assign({}, schema.fields);
    if (className === '_User') {
      fields._email_verify_token_expires_at = {type: 'Date'};
      fields._email_verify_token = {type: 'String'};
      fields._account_lockout_expires_at = {type: 'Date'};
      fields._failed_login_count = {type: 'Number'};
      fields._perishable_token = {type: 'String'};
      fields._perishable_token_expires_at = {type: 'Date'};
      fields._password_changed_at = {type: 'Date'};
      fields._password_history = { type: 'Array'};
    }
    let index = 2;
    const relations = [];
    Object.keys(fields).forEach((fieldName) => {
      const parseType = fields[fieldName];
      // Skip when it's a relation
      // We'll create the tables later
      if (parseType.type === 'Relation') {
        relations.push(fieldName)
        return;
      }
      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        parseType.contents = { type: 'String' };
      }
      valuesArray.push(fieldName);
      if (parseType.type === 'Date') {
        valuesArray.push(parseTypeToPostgresType(parseType));
        if (fieldName === 'createdAt') {
          patternsArray.push(`$${index}:name $${index + 1}:raw DEFAULT CURRENT_TIMESTAMP`);
        } else if (fieldName === 'updatedAt') {
          patternsArray.push(`$${index}:name $${index + 1}:raw DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
        } else {
          patternsArray.push(`$${index}:name $${index + 1}:raw NULL`);
        }
        index = index + 2;
        return;
      }
      patternsArray.push(`$${index}:name $${index + 1}:raw`);
      if (fieldName === 'objectId') {
        valuesArray.push(defaultUniqueKeyLength);
        patternsArray.push(`PRIMARY KEY ($${index}:name)`)
      } else if (fieldName === 'email' || fieldName === 'username' || fieldName === 'name') {
        valuesArray.push(defaultUniqueKeyLength);
      } else {
        valuesArray.push(parseTypeToPostgresType(parseType));
      }
      index = index + 2;
    });
    const qs = `CREATE TABLE IF NOT EXISTS \`$1:name\` (${patternsArray.join(',')})`;
    const values = [className, ...valuesArray];
    return this.connect()
      .then(() => this._ensureSchemaCollectionExists())
      .then(() => this.database.query(qs, values))
      .catch(error => {
        console.log('we messed up');
        if (error.code === PostgresDuplicateRelationError) {
        // Table already exists, must have been created by a different request. Ignore error.
        } else {
          throw error;
        }
      }).then(() => {
      // Create the relation tables
        return Promise.all(relations.map((fieldName) => {
          return this.database.query('CREATE TABLE IF NOT EXISTS `$1:name` (`relatedId` varChar(120), `owningId` varChar(120), PRIMARY KEY(`relatedId`, `owningId`))', [`_Join:${fieldName}:${className}`]);
        }));
      }).catch(error => {
        console.log('join error');
        console.log(error);
      });
  }

  addFieldIfNotExists(className, fieldName, type) {
    // TODO: Must be revised for invalid logic...
    debug('addFieldIfNotExists', {className, fieldName, type});
    return this.connect()
      .then(() => {
        let promise = Promise.resolve();
        if (type.type !== 'Relation') {
          let postgresType = parseTypeToPostgresType(type);
          if (type.type === 'Date') {
            postgresType = 'timestamp null default null';
          }
          promise = this.database.query('ALTER TABLE `$1:name` ADD COLUMN `$2:name` $3:name', [className, fieldName, postgresType])
            .catch((error) => {
              if (error.code === PostgresRelationDoesNotExistError) {

              } else if (error.code === MySQLDuplicateColumnError) {
                // Column already exists, created by other request. Carry on to
                // See if it's the right type.
              } else {
                console.log('unknown error');
                throw error;
              }
            })
        } else {
          promise = this.database.query("CREATE TABLE IF NOT EXISTS `$1:name` (`relatedId` varChar(120), `owningId` varChar(120), PRIMARY KEY(`relatedId`, `owningId`))", [`_Join:${fieldName}:${className}`]);
        }
        return promise;
      })
      .then(() => {
        return this.database.query('SELECT `schema` FROM `_SCHEMA` WHERE `className` = \'$1:name\' and (`schema`->>\'$.fields.$2:name\') is not null', [className, fieldName]);
      }).then(([result]) => {
        if (result[0]) {
          throw "Attempted to add a field that already exists";
        } else {
          const path = `'$.fields.${fieldName}'`;
          return this.database.query('UPDATE `_SCHEMA` SET `schema`=JSON_SET(`schema`, $1:name, CAST(\'$2:name\' AS JSON)) WHERE `className`=\'$3:name\'', [path, JSON.stringify(type), className]);
        }
      })
      .catch((error) => {
        console.log('what the hek');
        console.log(error);
      });
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  deleteClass(className) {
    const qs = 'DROP TABLE IF EXISTS `$1:name`; DELETE FROM `_SCHEMA` WHERE `className" = $1:name;';
    return this.connect()
      .then(() => this.database.query(qs, [className]))
      .then(() => className.indexOf('_Join:') != 0); // resolves with false when _Join table
  }

  // Delete all data known to this adapter. Used for testing.
  deleteAllClasses() {
    //return;
    const now = new Date().getTime();
    debug('deleteAllClasses');
    return this.connect()
      .then(() => this.database.query('SELECT * FROM `_SCHEMA`'))
      .then(([results]) => {
        const joins = results.reduce((list, schema) => {
          return list.concat(joinTablesForSchema(schema.schema));
        }, []);
        const classes = ['_SCHEMA', '_PushStatus', '_JobStatus', '_JobSchedule', '_Hooks', '_GlobalConfig', '_Audience', ...results.map(result => result.className), ...joins];
        let qs = "";
        for (let i = 1; i <= classes.length; i += 1) {
          qs += `DROP TABLE IF EXISTS \`$${i}:name\`;`;
        }
        debug(qs, classes);
        return this.database.query(qs, classes);
      })
      .then(() => {
        debug(`deleteAllClasses done in ${new Date().getTime() - now}`);
      })
      .catch((error) => {
        if (error.code === MySQLRelationDoesNotExistError) {
          // No _SCHEMA collection. Don't delete anything.
          return;
        } else {
          throw error;
        }
      });
  }

  // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.

  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.

  // Returns a Promise.
  deleteFields(className, schema, fieldNames) {
    debug('deleteFields', className, fieldNames);
    return Promise.resolve()
      .then(() => {
        fieldNames = fieldNames.reduce((list, fieldName) => {
          const field = schema.fields[fieldName]
          if (field.type !== 'Relation') {
            list.push(fieldName);
          }
          delete schema.fields[fieldName];
          return list;
        }, []);

        const values = [className, ...fieldNames];
        const columns = fieldNames.map((name, idx) => {
          return `$${idx + 2}:name`;
        }).join(', DROP COLUMN');

        const doBatch = (t) => {
          const batch = [
            t.none('UPDATE "_SCHEMA" SET "schema"=$<schema> WHERE "className"=$<className>', {schema, className})
          ];
          if (values.length > 1) {
            batch.push(t.none(`ALTER TABLE $1:name DROP COLUMN ${columns}`, values));
          }
          return batch;
        }
        return this._client.tx((t) => {
          return t.batch(doBatch(t));
        });
      });
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  getAllClasses() {
    debug('getAllClasses');
    return this._ensureSchemaCollectionExists()
      .then(() => this.database.query('SELECT * FROM `_SCHEMA`'))
      .catch((error) => {
        console.log('what is unahdled');
        console.log(error);
      })
      .then(([rows]) => {
        return rows.map((row) => {
          return toParseSchema({ className: row.className, ...row.schema });
        });
      })
      .catch((error) => {
        console.log('error yolo');
        console.log(error);
        if (error.code === PostgresDuplicateRelationError
          || error.code === PostgresUniqueIndexViolationError
          || error.code === PostgresDuplicateObjectError) {
        // Table already exists, must have been created by a different request. Ignore error.
        } else {
          throw error;
        }
      });
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  getClass(className) {
    debug('getClass', className);
    return this.connect()
      .then(() => this.database.query('SELECT * FROM `_SCHEMA` WHERE `className`=\'$1:name\'', [className ]))
      .then(([result]) => {
        if (result.length === 1) {
          return result[0].schema;
        } else {
          throw undefined;
        }
      }).then(toParseSchema);
  }

  // TODO: remove the mongo format dependency in the return value
  createObject(className, schema, object) {
    debug('createObject', className, object);
    let columnsArray = [];
    const valuesArray = [];
    schema = toPostgresSchema(schema);
    const geoPoints = {};

    object = handleDotFields(object);

    validateKeys(object);

    Object.keys(object).forEach(fieldName => {
      if (object[fieldName] === null) {
        return;
      }
      var authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      if (authDataMatch) {
        var provider = authDataMatch[1];
        object['authData'] = object['authData'] || {};
        object['authData'][provider] = object[fieldName];
        delete object[fieldName];
        fieldName = 'authData';
      }

      columnsArray.push(fieldName);
      if (!schema.fields[fieldName] && className === '_User') {
        if (fieldName === '_email_verify_token' ||
            fieldName === '_failed_login_count' ||
            fieldName === '_perishable_token' ||
            fieldName === '_password_history'){
          valuesArray.push(object[fieldName]);
        }

        if (fieldName === '_account_lockout_expires_at' ||
            fieldName === '_perishable_token_expires_at' ||
            fieldName === '_password_changed_at' ||
            fieldName === '_email_verify_token_expires_at') {
          if (object[fieldName]) {
            valuesArray.push(toPostgresValue(object[fieldName]));
          } else {
            valuesArray.push(null);
          }
        }
        return;
      }
      switch (schema.fields[fieldName].type) {
      case 'Date':
        if (object[fieldName]) {
          valuesArray.push(toPostgresValue(object[fieldName]));
        } else {
          valuesArray.push(null);
        }
        break;
      case 'Pointer':
        valuesArray.push(object[fieldName].objectId);
        break;
      case 'Array':
      case 'Object':
        valuesArray.push(JSON.stringify(object[fieldName]));
        break;
      case 'Bytes':
      case 'String':
      case 'Number':
      case 'Boolean':
        valuesArray.push(object[fieldName]);
        break;
      case 'File':
        valuesArray.push(object[fieldName].name);
        break;
      case 'GeoPoint':
        // pop the point and process later
        geoPoints[fieldName] = object[fieldName];
        columnsArray.pop();
        break;
      default:
        throw `Type ${schema.fields[fieldName].type} not supported yet`;
      }
    });

    columnsArray = columnsArray.concat(Object.keys(geoPoints));
    const initialValues = valuesArray.map((val, index) => {
      const fieldName = columnsArray[index];
      if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Boolean') {
        return `$${index + 2 + columnsArray.length}:name`;
      }
      return `'$${index + 2 + columnsArray.length}:name'`;
    });
    const geoPointsInjects = Object.keys(geoPoints).map((key) => {
      const value = geoPoints[key];
      valuesArray.push(value.longitude, value.latitude);
      const l = valuesArray.length + columnsArray.length;
      return `POINT($${l}, $${l + 1})`;
    });

    const columnsPattern = columnsArray.map((col, index) => `\`$${index + 2}:name\``).join(',');
    const valuesPattern = initialValues.concat(geoPointsInjects).join(',')
    const qs = `INSERT INTO \`$1:name\` (${columnsPattern}) VALUES (${valuesPattern})`
    const values = [className, ...columnsArray, ...valuesArray]
    debug(qs, values);
    return this.connect()
      .then(() => this.database.query(qs, values))
      .then(() => ({ ops: [object] }))
      .catch(error => {
        if (error.code === PostgresUniqueIndexViolationError) {
          throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        } else {
          throw error;
        }
      })
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  deleteObjectsByQuery(className, schema, query) {
    debug('deleteObjectsByQuery', className, query);
    const values = [className];
    const index = 2;
    const where = buildWhereClause({ schema, index, query })
    values.push(...where.values);
    if (Object.keys(query).length === 0) {
      where.pattern = 'TRUE';
    }
    const qs = `DELETE FROM $1:name WHERE ${where.pattern}`;
    debug(qs, values);
    return this.connect()
      .then(() => this.database.query(qs, values))
      .then(([result]) => {
        if (result.affectedRows === 0) {
          throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        } else {
          return result.affectedRows;
        }
      });
  }
  // Return value not currently well specified.
  findOneAndUpdate(className, schema, query, update) {
    debug('findOneAndUpdate', className, query, update);
    return this.updateObjectsByQuery(className, schema, query, update).then((val) => val);
  }

  // Apply the update to all objects that match the given Parse Query.
  updateObjectsByQuery(className, schema, query, update) {
    debug('updateObjectsByQuery', className, query, update);
    const updatePatterns = [];
    const values = [className]
    let index = 2;
    schema = toPostgresSchema(schema);

    const originalUpdate = {...update};
    update = handleDotFields(update);
    // Resolve authData first,
    // So we don't end up with multiple key updates
    for (const fieldName in update) {
      const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      if (authDataMatch) {
        var provider = authDataMatch[1];
        const value = update[fieldName];
        delete update[fieldName];
        update['authData'] = update['authData'] || {};
        update['authData'][provider] = value;
      }
    }

    for (const fieldName in update) {
      const fieldValue = update[fieldName];
      if (fieldValue === null) {
        updatePatterns.push(`$${index}:name = NULL`);
        values.push(fieldName);
        index += 1;
      } else if (fieldName == 'authData') {
        // This recursively sets the json_object
        // Only 1 level deep
        const generate = (jsonb, key, value) => {
          return `JSON_SET(COALESCE(\`${fieldName}\`, '{}'), '$.${key}', CAST('${value}' AS JSON))`;
        }
        const lastKey = `$${index}:name`;
        const fieldNameIndex = index;
        index += 1;
        values.push(`\`${fieldName}\``);
        const update = Object.keys(fieldValue).reduce((lastKey, key) => {
          const str = generate(lastKey, `$${index}:name`, `$${index + 1}:name`)
          index += 2;
          let value = fieldValue[key];
          if (value) {
            if (value.__op === 'Delete') {
              value = null;
            } else {
              value = JSON.stringify(value)
            }
          }
          values.push(key, value);
          return str;
        }, lastKey);
        updatePatterns.push(`$${fieldNameIndex}:name = ${update}`);
      } else if (fieldValue.__op === 'Increment') {
        updatePatterns.push(`\`$${index}:name\` = COALESCE($${index}:name, 0) + $${index + 1}`);
        values.push(fieldName, fieldValue.amount);
        index += 2;
      } else if (fieldValue.__op === 'Add') {
        updatePatterns.push(`\`$${index}:name\`= array_add(COALESCE($${index}:name, '[]':name), $${index + 1}:name)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'Delete') {
        updatePatterns.push(`\`$${index}:name\` = $${index + 1}`)
        values.push(fieldName, null);
        index += 2;
      } else if (fieldValue.__op === 'Remove') {
        updatePatterns.push(`\`$${index}:name\` = array_remove(COALESCE($${index}:name, '[]':name), $${index + 1}:name)`)
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'AddUnique') {
        updatePatterns.push(`\`$${index}:name\` = array_add_unique(COALESCE($${index}:name, '[]':name), $${index + 1}:name)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldName === 'updatedAt') { //TODO: stop special casing this. It should check for __type === 'Date' and use .iso
        updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`)
        values.push(fieldName, new Date(fieldValue).toISOString().slice(0, 19).replace('T', ' '));
        index += 2;
      } else if (typeof fieldValue === 'string') {
        updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'boolean') {
        updatePatterns.push(`\`$${index}:name\` = $${index + 1}:name`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'Pointer') {
        updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      } else if (fieldValue.__type === 'Date') {
        updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue instanceof Date) {
        updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'File') {
        updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue.__type === 'GeoPoint') {
        updatePatterns.push(`\`$${index}:name\` = POINT($${index + 1}, $${index + 2})`);
        values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
        index += 3;
      } else if (fieldValue.__type === 'Relation') {
        // noop
      } else if (typeof fieldValue === 'number') {
        updatePatterns.push(`\`$${index}:name\` = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'object'
                    && schema.fields[fieldName]
                    && schema.fields[fieldName].type === 'Object') {
        // Gather keys to increment
        const keysToIncrement = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set
          return originalUpdate[k].__op === 'Increment' && k.split('.').length === 2 && k.split(".")[0] === fieldName;
        }).map(k => k.split('.')[1]);

        let incrementPatterns = '';
        if (keysToIncrement.length > 0) {
          incrementPatterns = ' || ' + keysToIncrement.map((c) => {
            const amount = fieldValue[c].amount;
            return `CONCAT('{"${c}":', COALESCE($${index}:name->>'${c}','0')::int + ${amount}, '}'):name`;
          }).join(' || ');
          // Strip the keys
          keysToIncrement.forEach((key) => {
            delete fieldValue[key];
          });
        }

        const keysToDelete = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set
          return originalUpdate[k].__op === 'Delete' && k.split('.').length === 2 && k.split(".")[0] === fieldName;
        }).map(k => k.split('.')[1]);

        const deletePatterns = keysToDelete.reduce((p, c, i) => {
          return p + ` - '$${index + 1 + i}:value'`;
        }, '');

        updatePatterns.push(`$${index}:name = ( COALESCE($${index}:name, '{}':name) ${deletePatterns} ${incrementPatterns} || $${index + 1 + keysToDelete.length}:name )`);

        values.push(fieldName, ...keysToDelete, JSON.stringify(fieldValue));
        index += 2 + keysToDelete.length;
      } else if (Array.isArray(fieldValue)
                    && schema.fields[fieldName]
                    && schema.fields[fieldName].type === 'Array') {
        updatePatterns.push(`$${index}:name = '$${index + 1}:name'`);
        values.push(fieldName, JSON.stringify(fieldValue));
        index += 2;
      } else {
        debug('Not supported update', fieldName, fieldValue);
        return Promise.reject(new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, `Postgres doesn't support update ${JSON.stringify(fieldValue)} yet`));
      }
    }

    const where = buildWhereClause({ schema, index, query })
    values.push(...where.values);

    const qs = `UPDATE \`$1:name\` SET ${updatePatterns.join(',')} WHERE ${where.pattern}`;
    debug('update: ', qs, values);
    return this.connect()
      .then(() => this.database.query(qs, values))
      .then(([results]) => {
        if (results.affectedRows > 0) {
          return results;
        }
        return null;
      })
      .catch((error) => {
        console.log('slient but deadly');
        console.log(error);
      });
  }

  // Hopefully, we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update) {
    debug('upsertOneObject', {className, query, update});
    const createValue = Object.assign({}, query, update);
    return this.createObject(className, schema, createValue).catch((err) => {
      // ignore duplicate value errors as it's upsert
      if (err.code === Parse.Error.DUPLICATE_VALUE) {
        return this.findOneAndUpdate(className, schema, query, update);
      }
      throw err;
    });
  }

  find(className, schema, query, { skip, limit, sort, keys }) {
    debug('find', className, query, {skip, limit, sort, keys });
    const hasLimit = limit !== undefined;
    const hasSkip = skip !== undefined;
    let values = [className];
    const where = buildWhereClause({ schema, query, index: 2 })
    values.push(...where.values);

    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const limitPattern = hasLimit ? `LIMIT $${values.length + 1}:name` : '';
    if (hasLimit) {
      values.push(limit);
    }
    const skipPattern = hasSkip ? `OFFSET $${values.length + 1}:name` : '';
    if (hasSkip) {
      values.push(skip);
    }

    let sortPattern = '';
    if (sort) {
      const sorting = Object.keys(sort).map((key) => {
        // Using $idx pattern gives:  non-integer constant in ORDER BY
        if (sort[key] === 1) {
          return `\`${key}\` ASC`;
        }
        return `\`${key}\` DESC`;
      }).join(',');
      sortPattern = sort !== undefined && Object.keys(sort).length > 0 ? `ORDER BY ${sorting}` : '';
    }
    if (where.sorts && Object.keys(where.sorts).length > 0) {
      sortPattern = `ORDER BY ${where.sorts.join(',')}`;
    }

    let columns = '*';
    if (keys) {
      // Exclude empty keys
      keys = keys.filter((key) => {
        return key.length > 0;
      });
      columns = keys.map((key, index) => {
        if (key === '$score') {
          return `ts_rank_cd(to_tsvector($${2}:name, $${3}:name), to_tsquery($${4}:name, $${5}:name), 32) as score`;
        }
        return `\`$${index + values.length + 1}:name\``;
      }).join(',');
      values = values.concat(keys);
    }

    const qs = `SELECT ${columns} FROM \`$1:name\` ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern}`;
    debug(qs, values);
    return this.connect()
      .then(() => this.database.query(qs, values))
      .catch((err) => {
        // Query on non existing table, don't crash
        if (err.code === MySQLRelationDoesNotExistError) {
          return [[]];
        }
        return Promise.reject(err);
      })
      .then(([results]) => results.map(object => {
        Object.keys(schema.fields).forEach(fieldName => {
          if (schema.fields[fieldName].type === 'Pointer' && object[fieldName]) {
            object[fieldName] = { objectId: object[fieldName], __type: 'Pointer', className: schema.fields[fieldName].targetClass };
          }
          if (schema.fields[fieldName].type === 'Relation') {
            object[fieldName] = {
              __type: "Relation",
              className: schema.fields[fieldName].targetClass
            }
          }
          if (object[fieldName] && schema.fields[fieldName].type === 'GeoPoint') {
            object[fieldName] = {
              __type: "GeoPoint",
              latitude: object[fieldName].y,
              longitude: object[fieldName].x
            }
          }
          if (object[fieldName] && schema.fields[fieldName].type === 'File') {
            object[fieldName] = {
              __type: 'File',
              name: object[fieldName]
            }
          }
        });
        //TODO: remove this reliance on the mongo format. DB adapter shouldn't know there is a difference between created at and any other date field.
        if (object.createdAt) {
          object.createdAt = object.createdAt.toISOString();
        }
        if (object.updatedAt) {
          object.updatedAt = object.updatedAt.toISOString();
        }
        if (object.expiresAt) {
          object.expiresAt = { __type: 'Date', iso: object.expiresAt.toISOString() };
        }
        if (object._email_verify_token_expires_at) {
          object._email_verify_token_expires_at = { __type: 'Date', iso: object._email_verify_token_expires_at.toISOString() };
        }
        if (object._account_lockout_expires_at) {
          object._account_lockout_expires_at = { __type: 'Date', iso: object._account_lockout_expires_at.toISOString() };
        }
        if (object._perishable_token_expires_at) {
          object._perishable_token_expires_at = { __type: 'Date', iso: object._perishable_token_expires_at.toISOString() };
        }
        if (object._password_changed_at) {
          object._password_changed_at = { __type: 'Date', iso: object._password_changed_at.toISOString() };
        }

        for (const fieldName in object) {
          if (object[fieldName] === null) {
            delete object[fieldName];
          }
          if (object[fieldName] instanceof Date) {
            object[fieldName] = { __type: 'Date', iso: object[fieldName].toISOString() };
          }
        }
        // console.log('found');
        // console.log(object);
        return object;
      }));
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  ensureUniqueness(className, schema, fieldNames) {
    // Use the same name for every ensureUniqueness attempt, because postgres
    // Will happily create the same index with multiple names.
    const constraintName = `unique_${fieldNames.sort().join('_')}`;
    const constraintPatterns = fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `ALTER TABLE $1:name ADD CONSTRAINT $2:name UNIQUE (${constraintPatterns.join(',')})`;
    debug('ensureUniqueness', qs, [className, constraintName, ...fieldNames]);
    return this.connect()
      .then(() => this.database.query(qs, [className, constraintName, ...fieldNames]))
      .then(([res]) => {
        return res;
      })
      .catch(error => {
        if (error.code === MySQLUniqueIndexViolationError && error.message.includes(constraintName)) {
        // Index already exists. Ignore error.
        } else if (error.code === MySQLDuplicateColumnError && error.message.includes(constraintName)) {
        // Cast the error into the proper parse error
          throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        } else {
          throw error;
        }
      });
  }

  // Executes a count.
  count(className, schema, query) {
    debug('count', className, query);
    const values = [className];
    const where = buildWhereClause({ schema, query, index: 2 });
    values.push(...where.values);

    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `SELECT count(*) FROM $1:name ${wherePattern}`;
    return this.connect()
      .then(() => this.database.query(qs, values))
      .then(([result]) => result[0]['count(*)'])
      .catch((err) => {
        if (err.code === PostgresRelationDoesNotExistError) {
          return 0;
        }
        throw err;
      });
  }

  performInitialization({ VolatileClassesSchemas }) {
    debug('performInitialization');
    const promises = VolatileClassesSchemas.map((schema) => {
      return this.connect()
        .then(() => this.createTable(schema.className, schema))
        .catch((err) => {
          if (err.code === PostgresDuplicateRelationError || err.code === Parse.Error.INVALID_CLASS_NAME) {
            return Promise.resolve();
          }
          throw err;
        });
    });
    return Promise.all(promises)
      .then(() => {
        debug('initializationDone');
      })
      .catch(error => {
        /* eslint-disable no-console */
        console.error(error);
      });
  }
}

function removeWhiteSpace(regex) {
  if (!regex.endsWith('\n')){
    regex += '\n';
  }

  // remove non escaped comments
  return regex.replace(/([^\\])#.*\n/gmi, '$1')
    // remove lines starting with a comment
    .replace(/^#.*\n/gmi, '')
    // remove non escaped whitespace
    .replace(/([^\\])\s+/gmi, '$1')
    // remove whitespace at the beginning of a line
    .replace(/^\s+/, '')
    .trim();
}

function processRegexPattern(s) {
  if (s && s.startsWith('^')){
    // regex for startsWith
    return '^' + literalizeRegexPart(s.slice(1));

  } else if (s && s.endsWith('$')) {
    // regex for endsWith
    return literalizeRegexPart(s.slice(0, s.length - 1)) + '$';
  }

  // regex for contains
  return literalizeRegexPart(s);
}

function createLiteralRegex(remaining) {
  return remaining.split('').map(c => {
    if (c.match(/[0-9a-zA-Z]/) !== null) {
      // don't escape alphanumeric characters
      return c;
    }
    // escape everything else (single quotes with single quotes, everything else with a backslash)
    return c === `'` ? `''` : `\\${c}`;
  }).join('');
}

function literalizeRegexPart(s) {
  const matcher1 = /\\Q((?!\\E).*)\\E$/
  const result1 = s.match(matcher1);
  if(result1 && result1.length > 1 && result1.index > -1){
    // process regex that has a beginning and an end specified for the literal text
    const prefix = s.substr(0, result1.index);
    const remaining = result1[1];

    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // process regex that has a beginning specified for the literal text
  const matcher2 = /\\Q((?!\\E).*)$/
  const result2 = s.match(matcher2);
  if(result2 && result2.length > 1 && result2.index > -1){
    const prefix = s.substr(0, result2.index);
    const remaining = result2[1];

    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // remove all instances of \Q and \E from the remaining text & escape single quotes
  return (
    s.replace(/([^\\])(\\E)/, '$1')
    .replace(/([^\\])(\\Q)/, '$1')
    .replace(/^\\E/, '')
    .replace(/^\\Q/, '')
    .replace(/([^'])'/, `$1''`)
    .replace(/^'([^'])/, `''$1`)
    .replace('\\w','[0-9a-zA-Z]')
  );
}

export default MySQLStorageAdapter;
module.exports = MySQLStorageAdapter;
