import normalizeErrors from './normalizeErrors';

export default (stats) => normalizeErrors(stats.compilation.warnings).sort();
