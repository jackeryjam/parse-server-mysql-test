import Parse            from 'parse/node';
import _                from 'lodash';

const parseTypeToMySQLType = type => {
  switch (type.type) {
  case 'String': return 'text';
  case 'Date': return 'timestamp(6)';
  case 'Object': return 'json';
  case 'File': return 'text';
  case 'Boolean': return 'boolean';
  case 'Pointer': return 'char(10)';
  case 'Number': return 'double precision';
  case 'GeoPoint': return 'point';
  case 'Bytes': return 'json';
  case 'Array': return 'json';
  default: throw `no type for ${JSON.stringify(type)} yet`;
  }
};

const ParseToMySQLComparator = {
  '$gt': '>',
  '$lt': '<',
  '$gte': '>=',
  '$lte': '<='
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

const toMySQLValue = value => {
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      if (!value.iso) {
        return null;
      }
      return formatDateToMySQL(value.iso);
    }
    if (value.__type === 'File') {
      return value.name;
    }
  }
  return value;
}

const formatDateToMySQL = value => {
  const encoded = Parse._encode(new Date(value));
  encoded.iso = encoded.iso.replace('T', ' ').replace('Z', '');
  if (!value.iso) {
    return encoded.iso;
  }
  return encoded;
}

const transformValue = value => {
  if (typeof value === 'object' &&
        value.__type === 'Pointer') {
    return value.objectId;
  }
  return value;
}

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

const toMySQLSchema = (schema) => {
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

const buildWhereClause = ({ schema, query, index }) => {
  const patterns = [];
  let values = [];
  const sorts = [];

  schema = toMySQLSchema(schema);
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
        patterns.push(`\`${name}\` IS NULL`);
      } else {
        patterns.push(`${name} = '${fieldValue}'`);
      }
    } else if (fieldValue === null) {
      patterns.push(`\`$${index}:name\` IS NULL`);
      values.push(fieldName);
      index += 1;
      continue;
    } else if (typeof fieldValue === 'string') {
      patterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'boolean') {
      patterns.push(`\`$${index}:name\` = $${index + 1}:name`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'number') {
      patterns.push(`\`$${index}:name\` = $${index + 1}:name`);
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
          patterns.push(`\`$${index}:name\` IS NOT NULL`);
          values.push(fieldName);
          index += 1;
          continue;
        } else {
          // if not null, we need to manually exclude null
          patterns.push(`(\`$${index}:name\` <> '$${index + 1}:name' OR \`$${index}:name\` IS NULL)`);
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
          inPatterns.push(`JSON_CONTAINS(\`$${index}:name\`, JSON_ARRAY('$${index + 1 + listIndex - (allowNull ? 1 : 0)}:name')) = 1`);
        }
      });
      const tempInPattern = inPatterns.join(' OR ');
      if (allowNull) {
        patterns.push(`(\`$${index}:name\` IS NULL OR ${tempInPattern})`);
      } else {
        patterns.push(`\`$${index}:name\` && ${tempInPattern}`);
      }
      index = index + 1 + inPatterns.length;
    } else if (isInOrNin) {
      var createConstraint = (baseArray, notIn) => {
        if (baseArray.length > 0) {
          const not = notIn ? ' NOT ' : '';
          if (isArrayField) {
            const operator = notIn ? ' != ' : ' = ';
            const inPatterns = [];
            values.push(fieldName);
            baseArray.forEach((listElem, listIndex) => {
              values.push(JSON.stringify(listElem));
              inPatterns.push(`JSON_CONTAINS(\`$${index}:name\`, '$${index + 1 + listIndex}:name') ${operator} 1`);
            });
            patterns.push(`${inPatterns.join(' || ')}`);
            index = index + 1 + inPatterns.length;
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
          patterns.push(`\`$${index}:name\` IS NULL`);
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
        patterns.push(`\`$${index}:name\` IS NULL`);
      }
      values.push(fieldName);
      index += 1;
    }

    if (fieldValue.$text) {
      const search = fieldValue.$text.$search;
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
          `bad $text: $diacriticSensitive - false not supported, install MySQL Unaccent Extension`
        );
      }
      patterns.push(`MATCH (\`$${index}:name\`) AGAINST ('$${index + 1}:name')`);
      values.push(fieldName, search.$term);
      index += 2;
    }

    if (fieldValue.$nearSphere) {
      const point = fieldValue.$nearSphere;
      sorts.push(`ST_Distance_Sphere(\`$${index}:name\`, ST_GeomFromText('POINT($${index + 1}:name $${index + 2}:name)')) ASC`);

      if (fieldValue.$maxDistance) {
        const distance = fieldValue.$maxDistance;
        const distanceInKM = distance * 6371 * 1000;
        patterns.push(`ST_Distance_Sphere(\`$${index}:name\`, ST_GeomFromText('POINT($${index + 1}:name $${index + 2}:name)')) <= $${index + 3}:name`);
        values.push(fieldName, point.longitude, point.latitude, distanceInKM);
        index += 4;
      } else {
        patterns.push(`ST_Distance_Sphere(\`$${index}:name\`, ST_GeomFromText('POINT($${index + 1}:name $${index + 2}:name)'))`);
        values.push(fieldName, point.longitude, point.latitude);
        index += 3;
      }
    }

    if (fieldValue.$within && fieldValue.$within.$box) {
      const box = fieldValue.$within.$box;
      const left = box[0].longitude;
      const bottom = box[0].latitude;
      const right = box[1].longitude;
      const top = box[1].latitude;

      patterns.push(`MBRCovers(ST_GeomFromText('Polygon($${index}:name)'), \`$${index + 1}:name\`)`);
      values.push(`(${left} ${bottom}, ${left} ${top}, ${top} ${right}, ${right} ${bottom}, ${left} ${bottom})`, fieldName);
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
      if (polygon[0].latitude !== polygon[polygon.length - 1].latitude ||
        polygon[0].longitude !== polygon[polygon.length - 1].longitude) {
        polygon.push(polygon[0]);
      }
      const points = polygon.map((point) => {
        if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value');
        } else {
          Parse.GeoPoint._validate(point.latitude, point.longitude);
        }
        return `${point.longitude} ${point.latitude}`;
      }).join(', ');

      patterns.push(`MBRCovers(ST_GeomFromText('Polygon($${index}:name)'), \`$${index + 1}:name\`)`);
      values.push(`(${points})`, fieldName);
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
      values.push(fieldName, toMySQLValue(fieldValue));
      index += 2;
    }

    if (fieldValue.__type === 'GeoPoint') {
      patterns.push(`\`$${index}:name\` = ST_GeomFromText('POINT($${index + 1}:name $${index + 2}:name)')`);
      values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
      index += 3;
    }

    Object.keys(ParseToMySQLComparator).forEach(cmp => {
      if (fieldValue[cmp]) {
        const mysqlComparator = ParseToMySQLComparator[cmp];
        patterns.push(`\`$${index}:name\` ${mysqlComparator} '$${index + 1}:name'`);
        values.push(fieldName, toMySQLValue(fieldValue[cmp]));
        index += 2;
      }
    });

    if (initialPatternsLength === patterns.length) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, `MySQL does not support this query type yet ${fieldValue}`);
    }
  }
  values = values.map(transformValue);
  return { pattern: patterns.join(' AND '), values, sorts };
}

const transformUpdate = (schema, update) => {
  const updatePatterns = [];
  const values = [];
  const originalUpdate = {...update};
  update = handleDotFields(update);

  let index = 2;

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
      updatePatterns.push(`\`$${index}:name\` = COALESCE(\`$${index}:name\`, 0) + $${index + 1}:name`);
      values.push(fieldName, fieldValue.amount);
      index += 2;
    } else if (fieldValue.__op === 'Add') {
      updatePatterns.push(`\`$${index}:name\`= JSON_ARRAY_INSERT(COALESCE(\`$${index}:name\`, '[]'), CONCAT('$[',JSON_LENGTH(\`$${index}:name\`),']'), '$${index + 1}:name')`);
      values.push(fieldName, JSON.stringify(fieldValue.objects));
      index += 2;
    } else if (fieldValue.__op === 'Delete') {
      updatePatterns.push(`\`$${index}:name\` = $${index + 1}`)
      values.push(fieldName, null);
      index += 2;
    } else if (fieldValue.__op === 'Remove') {
      fieldValue.objects.map((obj) => {
        updatePatterns.push(`\`$${index}:name\` = JSON_REMOVE(\`$${index}:name\`, REPLACE(JSON_SEARCH(COALESCE(\`$${index}:name\`,'[]'), 'one', '$${index + 1}:name'),'"',''))`)
        if (typeof obj === 'object') {
          values.push(fieldName, JSON.stringify(obj));
        } else {
          values.push(fieldName, obj);
        }
        index += 2;
      });
    } else if (fieldValue.__op === 'AddUnique') {
      fieldValue.objects.map((obj) => {
        updatePatterns.push(`\`$${index}:name\` = if (JSON_CONTAINS(\`$${index}:name\`, '$${index + 1}:name') = 0, JSON_MERGE(\`$${index}:name\`,'$${index + 1}:name'),\`$${index}:name\`)`);
        if (typeof obj === 'object') {
          values.push(fieldName, JSON.stringify(obj));
        } else {
          values.push(fieldName, obj);
        }
        index += 2;
      });
    //TODO: stop special casing this. It should check for __type === 'Date' and use .iso
    } else if (fieldName === 'updatedAt' || fieldName === 'finishedAt') {
      updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`)
      values.push(fieldName, formatDateToMySQL(fieldValue));
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
      values.push(fieldName, toMySQLValue(fieldValue));
      index += 2;
    } else if (fieldValue instanceof Date) {
      updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (fieldValue.__type === 'File') {
      updatePatterns.push(`\`$${index}:name\` = '$${index + 1}:name'`);
      values.push(fieldName, toMySQLValue(fieldValue));
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

      const keysToSet = Object.keys(originalUpdate).filter(k => {
        // choose top level fields that don't have operation or . (dot) field
        return !originalUpdate[k].__op && k.indexOf('.') === -1 && k !== 'updatedAt';
      });

      let setPattern = '';
      if (keysToSet.length > 0) {
        setPattern = keysToSet.map(() => {
          return `CAST('${JSON.stringify(fieldValue)}' AS JSON)`;
        });
      }
      const keysToReplace = Object.keys(originalUpdate).filter(k => {
        // choose top level fields that dont have operation
        return !originalUpdate[k].__op && k.split('.').length === 2 && k.split(".")[0] === fieldName;
      }).map(k => k.split('.')[1]);

      let replacePattern = '';
      if (keysToReplace.length > 0) {
        replacePattern = keysToReplace.map((c) => {
          if (typeof fieldValue[c] === 'object') {
            return `'$.${c}', CAST('${JSON.stringify(fieldValue[c])}' AS JSON)`;
          } else {
            return `'$.${c}', '${fieldValue[c]}'`;
          }
        }).join(' || ');

        keysToReplace.forEach((key) => {
          delete fieldValue[key];
        });
      }

      const keysToIncrement = Object.keys(originalUpdate).filter(k => {
        // choose top level fields that have a increment operation set
        return originalUpdate[k].__op === 'Increment' && k.split('.').length === 2 && k.split(".")[0] === fieldName;
      }).map(k => k.split('.')[1]);

      let incrementPatterns = '';
      if (keysToIncrement.length > 0) {
        incrementPatterns = keysToIncrement.map((c) => {
          const amount = fieldValue[c].amount;
          return `'$.${c}', COALESCE(\`$${index}:name\`->>'$.${c}','0') + ${amount}`;
        }).join(' || ');

        keysToIncrement.forEach((key) => {
          delete fieldValue[key];
        });
      }

      const keysToDelete = Object.keys(originalUpdate).filter(k => {
        // choose top level fields that have a delete operation set
        return originalUpdate[k].__op === 'Delete' && k.split('.').length === 2 && k.split(".")[0] === fieldName;
      }).map(k => k.split('.')[1]);

      const deletePatterns = keysToDelete.reduce((p, c, i) => {
        return `'$.$${index + 1 + i}:name'`;
      }, ', ');

      if (keysToDelete.length > 0) {
        updatePatterns.push(`\`$${index}:name\` = JSON_REMOVE(\`$${index}:name\`, ${deletePatterns})`);
      }
      if (keysToIncrement.length > 0) {
        updatePatterns.push(`\`$${index}:name\` = JSON_SET(COALESCE(\`$${index}:name\`, '{}'), ${incrementPatterns})`);
      }
      if (keysToReplace.length > 0) {
        updatePatterns.push(`\`$${index}:name\` = JSON_SET(COALESCE(\`$${index}:name\`, '{}'), ${replacePattern})`);
      }
      if (keysToSet.length > 0) {
        updatePatterns.push(`\`$${index}:name\` = ${setPattern}`);
      }

      values.push(fieldName, ...keysToDelete, JSON.stringify(fieldValue));
      index += 2 + keysToDelete.length;
    } else if (Array.isArray(fieldValue)
                  && schema.fields[fieldName]
                  && schema.fields[fieldName].type === 'Array') {
      updatePatterns.push(`$${index}:name = '$${index + 1}:name'`);
      values.push(fieldName, JSON.stringify(fieldValue));
      index += 2;
    } else {
      return Promise.reject(new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, `MySQL doesn't support update ${JSON.stringify(fieldValue)} yet`));
    }
  }
  return { pattern: updatePatterns.join(','), index, values };
}

module.exports = {
  toParseSchema,
  toMySQLSchema,
  parseTypeToMySQLType,
  joinTablesForSchema,
  handleDotFields,
  validateKeys,
  toMySQLValue,
  buildWhereClause,
  formatDateToMySQL,
  transformUpdate,
};