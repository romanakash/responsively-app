import React from 'react';
import filter from 'lodash/filter';
import settings from 'electron-settings';
import {ADD_SEARCH_RESULTS} from '../../constants/searchResultSettings';

let previousSearchResults = settings.get(ADD_SEARCH_RESULTS);

export const getExistingSearchResults = () => settings.get(ADD_SEARCH_RESULTS);

const addUrlToSearchResults = url => settings.set(ADD_SEARCH_RESULTS, url);

const deleteSearchResults = () => settings.delete(ADD_SEARCH_RESULTS);

const _sortedExistingUrlSearchResult = filteredData => {
  // Most visited site should appear first in the list
  filteredData.sort((a, b) => {
    if (a.visitedCount > b.visitedCount) {
      return -1;
    }

    if (a.visitedCount < b.visitedCount) {
      return 1;
    }
    return 0;
  });
  return filteredData;
};

export const searchUrlUtils = url => {
  if (url) {
    const filteredData = filter(previousSearchResults, eachResult =>
      eachResult.url.toLowerCase().includes(url)
    );
    const finalResult = _sortedExistingUrlSearchResult(filteredData);
    return finalResult;
  }
  return [];
};

const normalizeURL = url => {
  if (
    url.indexOf('?') === -1 &&
    !url.endsWith('/') &&
    url.indexOf('file://') === -1
  ) {
    url = `${url}/`;
  }
  return url;
};

export const updateExistingUrl = url => {
  url = normalizeURL(url);
  if (previousSearchResults?.length) {
    let updatedSearchResults = [...previousSearchResults];

    const index = updatedSearchResults.findIndex(
      eachSearchResult => eachSearchResult.url === url
    );

    if (index !== (undefined || -1 || null)) {
      updatedSearchResults[index].visitedCount =
        1 + updatedSearchResults[index].visitedCount;
    } else {
      updatedSearchResults = [
        {url, visitedCount: 1},
        ...updatedSearchResults,
      ].slice(0, 300);
    }

    addUrlToSearchResults(updatedSearchResults);
    previousSearchResults = updatedSearchResults;
  } else {
    const addNewUrl = [];
    addNewUrl.push({
      url,
      visitedCount: 1,
    });
    addUrlToSearchResults(addNewUrl);
    previousSearchResults = addNewUrl;
  }
  return previousSearchResults;
};
