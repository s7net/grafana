// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/querybuilder/components/MetricsLabelsSection.tsx
import { useCallback } from 'react';

import { SelectableValue, TimeRange } from '@grafana/data';

import { PrometheusDatasource } from '../../datasource';
import { getMetadataString } from '../../language_provider';
import { truncateResult } from '../../language_utils';
import { regexifyLabelValuesQueryString } from '../parsingUtils';
import { promQueryModeller } from '../shared/modeller_instance';
import { QueryBuilderLabelFilter } from '../shared/types';
import { PromVisualQuery } from '../types';

import { LabelFilters } from './LabelFilters';
import { MetricCombobox } from './MetricCombobox';

export interface MetricsLabelsSectionProps {
  query: PromVisualQuery;
  datasource: PrometheusDatasource;
  onChange: (update: PromVisualQuery) => void;
  variableEditor?: boolean;
  onBlur?: () => void;
  timeRange: TimeRange;
}

export function MetricsLabelsSection({
  datasource,
  query,
  onChange,
  onBlur,
  variableEditor,
  timeRange,
}: MetricsLabelsSectionProps) {
  // fixing the use of 'as' from refactoring
  // @ts-ignore
  const onChangeLabels = (labels) => {
    onChange({ ...query, labels });
  };
  /**
   * Map metric metadata to SelectableValue for Select component and also adds defined template variables to the list.
   */
  const withTemplateVariableOptions = useCallback(
    async (optionsPromise: Promise<SelectableValue[]>): Promise<SelectableValue[]> => {
      const variables = datasource.getVariables();
      const options = await optionsPromise;
      return [
        ...variables.map((value: string) => ({ label: value, value })),
        ...options.map((option: SelectableValue) => ({
          label: option.value,
          value: option.value,
          title: option.description,
        })),
      ];
    },
    [datasource]
  );

  /**
   * Function kicked off when user interacts with label in label filters.
   * Formats a promQL expression and passes that off to helper functions depending on API support
   * @param forLabel
   */
  const onGetLabelNames = async (forLabel: Partial<QueryBuilderLabelFilter>): Promise<SelectableValue[]> => {
    // If no metric we need to use a different method
    if (!query.metric) {
      await datasource.languageProvider.fetchLabels(timeRange);
      return datasource.languageProvider.getLabelKeys().map((k) => ({ value: k }));
    }

    const labelsToConsider = query.labels.filter((x) => x !== forLabel);
    // eslint-disable-next-line @grafana/i18n/no-untranslated-strings
    labelsToConsider.push({ label: '__name__', op: '=', value: query.metric });
    const expr = promQueryModeller.renderLabels(labelsToConsider);

    let labelsIndex: Record<string, string[]> = await datasource.languageProvider.fetchLabelsWithMatch(timeRange, expr);

    // filter out already used labels
    return Object.keys(labelsIndex)
      .filter((labelName) => !labelsToConsider.find((filter) => filter.label === labelName))
      .map((k) => ({ value: k }));
  };

  const getLabelValuesAutocompleteSuggestions = (
    queryString?: string,
    labelName?: string
  ): Promise<SelectableValue[]> => {
    const forLabel = {
      label: labelName ?? '__name__',
      op: '=~',
      value: regexifyLabelValuesQueryString(`.*${queryString}`),
    };
    const labelsToConsider = query.labels.filter((x) => x.label !== forLabel.label);
    labelsToConsider.push(forLabel);
    if (query.metric) {
      // eslint-disable-next-line @grafana/i18n/no-untranslated-strings
      labelsToConsider.push({ label: '__name__', op: '=', value: query.metric });
    }
    const interpolatedLabelsToConsider = labelsToConsider.map((labelObject) => ({
      ...labelObject,
      label: datasource.interpolateString(labelObject.label),
      value: datasource.interpolateString(labelObject.value),
    }));
    const expr = promQueryModeller.renderLabels(interpolatedLabelsToConsider);
    let response: Promise<SelectableValue[]>;
    if (datasource.hasLabelsMatchAPISupport()) {
      response = getLabelValuesFromLabelValuesAPI(forLabel, expr);
    } else {
      response = getLabelValuesFromSeriesAPI(forLabel, expr);
    }

    return response.then((response: SelectableValue[]) => {
      truncateResult(response);
      return response;
    });
  };

  /**
   * Helper function to fetch and format label value results from legacy API
   * @param forLabel
   * @param promQLExpression
   */
  const getLabelValuesFromSeriesAPI = (
    forLabel: Partial<QueryBuilderLabelFilter>,
    promQLExpression: string
  ): Promise<SelectableValue[]> => {
    if (!forLabel.label) {
      return Promise.resolve([]);
    }
    const result = datasource.languageProvider.fetchSeries(timeRange, promQLExpression);
    const forLabelInterpolated = datasource.interpolateString(forLabel.label);
    return result.then((result) => {
      // This query returns duplicate values, scrub them out
      const set = new Set<string>();
      result.forEach((labelValue) => {
        const labelNameString = labelValue[forLabelInterpolated];
        set.add(labelNameString);
      });

      return Array.from(set).map((labelValues: string) => ({ label: labelValues, value: labelValues }));
    });
  };

  /**
   * Helper function to fetch label values from a promql string expression and a label
   * @param forLabel
   * @param promQLExpression
   */
  const getLabelValuesFromLabelValuesAPI = (
    forLabel: Partial<QueryBuilderLabelFilter>,
    promQLExpression: string
  ): Promise<SelectableValue[]> => {
    if (!forLabel.label) {
      return Promise.resolve([]);
    }

    const requestId = `[${datasource.uid}][${query.metric}][${forLabel.label}][${forLabel.op}]`;

    return datasource.languageProvider
      .fetchSeriesValuesWithMatch(timeRange, forLabel.label, promQLExpression, requestId)
      .then((response) => response.map((v) => ({ value: v, label: v })));
  };

  /**
   * Function kicked off when users interact with the value of the label filters
   * Formats a promQL expression and passes that into helper functions depending on API support
   * @param forLabel
   */
  const onGetLabelValues = async (forLabel: Partial<QueryBuilderLabelFilter>): Promise<SelectableValue[]> => {
    if (!forLabel.label) {
      return [];
    }
    // If no metric is selected, we can get the raw list of labels
    if (!query.metric) {
      return (await datasource.languageProvider.getLabelValues(timeRange, forLabel.label)).map((v) => ({ value: v }));
    }

    const labelsToConsider = query.labels.filter((x) => x !== forLabel);
    // eslint-disable-next-line @grafana/i18n/no-untranslated-strings
    labelsToConsider.push({ label: '__name__', op: '=', value: query.metric });

    const interpolatedLabelsToConsider = labelsToConsider.map((labelObject) => ({
      ...labelObject,
      label: datasource.interpolateString(labelObject.label),
      value: datasource.interpolateString(labelObject.value),
    }));

    const expr = promQueryModeller.renderLabels(interpolatedLabelsToConsider);

    if (datasource.hasLabelsMatchAPISupport()) {
      return getLabelValuesFromLabelValuesAPI(forLabel, expr);
    } else {
      return getLabelValuesFromSeriesAPI(forLabel, expr);
    }
  };

  const onGetMetrics = useCallback(() => {
    return withTemplateVariableOptions(getMetrics(datasource, query, timeRange));
  }, [datasource, query, timeRange, withTemplateVariableOptions]);

  return (
    <>
      <MetricCombobox
        query={query}
        onChange={onChange}
        onGetMetrics={onGetMetrics}
        datasource={datasource}
        labelsFilters={query.labels}
        metricLookupDisabled={datasource.lookupsDisabled}
        onBlur={onBlur ? onBlur : () => {}}
        variableEditor={variableEditor}
      />
      <LabelFilters
        debounceDuration={datasource.getDebounceTimeInMilliseconds()}
        getLabelValuesAutofillSuggestions={getLabelValuesAutocompleteSuggestions}
        labelsFilters={query.labels}
        onChange={onChangeLabels}
        onGetLabelNames={(forLabel) => withTemplateVariableOptions(onGetLabelNames(forLabel))}
        onGetLabelValues={(forLabel) => withTemplateVariableOptions(onGetLabelValues(forLabel))}
        variableEditor={variableEditor}
      />
    </>
  );
}

/**
 * Returns list of metrics, either all or filtered by query param. It also adds description string to each metric if it
 * exists.
 * @param datasource
 * @param query
 */
async function getMetrics(
  datasource: PrometheusDatasource,
  query: PromVisualQuery,
  timeRange: TimeRange
): Promise<Array<{ value: string; description?: string }>> {
  // Makes sure we loaded the metadata for metrics. Usually this is done in the start() method of the provider but we
  // don't use it with the visual builder and there is no need to run all the start() setup anyway.
  if (!datasource.languageProvider.metricsMetadata) {
    await datasource.languageProvider.loadMetricsMetadata();
  }

  // Error handling for when metrics metadata returns as undefined
  if (!datasource.languageProvider.metricsMetadata) {
    datasource.languageProvider.metricsMetadata = {};
  }

  let metrics: string[];
  if (query.labels.length > 0) {
    const expr = promQueryModeller.renderLabels(query.labels);
    metrics = (await datasource.languageProvider.getSeriesValues(timeRange, '__name__', expr)) ?? [];
  } else {
    metrics = (await datasource.languageProvider.getLabelValues(timeRange, '__name__')) ?? [];
  }

  return metrics.map((m) => ({
    value: m,
    description: getMetadataString(m, datasource.languageProvider.metricsMetadata!),
  }));
}
