---
name: data-analysis
description: Use when the user wants to analyze data, create visualizations, process CSV/Excel files, compute statistics, or build data pipelines. Triggers include requests for charts, graphs, data exploration, statistical analysis, pivot tables, data cleaning, trend analysis, or any data-driven insights. Also use for machine learning tasks, predictions, and data transformation.
tools:
  - code_execution
  - file_write
  - file_read
  - bash
  - web_search
---

# Data Analysis and Visualization

## Overview
Perform data analysis using Python with pandas, numpy, and matplotlib/seaborn. Generate visualizations and export results as files for download.

## Data Loading

```python
import pandas as pd
import numpy as np

# CSV
df = pd.read_csv("data.csv")

# Excel
df = pd.read_excel("data.xlsx", sheet_name="Sheet1")

# JSON
df = pd.read_json("data.json")

# From dict
df = pd.DataFrame({"col1": [1, 2, 3], "col2": ["a", "b", "c"]})
```

## Exploratory Analysis

```python
# Overview
print(df.shape)
print(df.dtypes)
print(df.describe())
print(df.isnull().sum())

# Value distributions
print(df["category"].value_counts())

# Correlations
print(df.select_dtypes(include=[np.number]).corr())
```

## Data Cleaning

```python
# Handle missing values
df = df.dropna(subset=["critical_column"])
df["optional"] = df["optional"].fillna(df["optional"].median())

# Remove duplicates
df = df.drop_duplicates(subset=["id"])

# Type conversion
df["date"] = pd.to_datetime(df["date"])
df["amount"] = pd.to_numeric(df["amount"], errors="coerce")

# String cleaning
df["name"] = df["name"].str.strip().str.title()
```

## Aggregation and Grouping

```python
# Group by with multiple aggregations
summary = df.groupby("category").agg(
    count=("id", "count"),
    total=("amount", "sum"),
    average=("amount", "mean"),
    max_val=("amount", "max")
).reset_index()

# Pivot table
pivot = pd.pivot_table(df, values="amount", index="category",
                       columns="month", aggfunc="sum", fill_value=0)

# Rolling averages
df["rolling_avg"] = df["value"].rolling(window=7).mean()
```

## Visualization

```python
import matplotlib.pyplot as plt
import matplotlib
matplotlib.use("Agg")  # Non-interactive backend

# Professional style setup
plt.style.use("seaborn-v0_8-whitegrid")
fig, ax = plt.subplots(figsize=(10, 6))

# Bar chart
categories = ["Q1", "Q2", "Q3", "Q4"]
values = [150, 230, 180, 310]
colors = ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"]
ax.bar(categories, values, color=colors, width=0.6)
ax.set_title("Quarterly Revenue", fontsize=16, fontweight="bold", pad=15)
ax.set_ylabel("Revenue ($K)")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

plt.tight_layout()
plt.savefig("chart.png", dpi=150, bbox_inches="tight")
plt.close()
```

### Chart Types

```python
# Line chart
ax.plot(dates, values, color="#2563eb", linewidth=2, marker="o", markersize=4)

# Pie chart
ax.pie(sizes, labels=labels, colors=colors, autopct="%1.1f%%", startangle=90)

# Scatter plot
ax.scatter(x, y, c=colors, s=sizes, alpha=0.7)

# Histogram
ax.hist(data, bins=30, color="#2563eb", alpha=0.7, edgecolor="white")

# Heatmap (with seaborn)
import seaborn as sns
sns.heatmap(corr_matrix, annot=True, cmap="RdBu_r", center=0, ax=ax)
```

## Statistical Analysis

```python
from scipy import stats

# Descriptive stats
mean, std = np.mean(data), np.std(data)
median = np.median(data)

# Hypothesis testing
t_stat, p_value = stats.ttest_ind(group_a, group_b)

# Correlation
r, p = stats.pearsonr(x, y)

# Linear regression
slope, intercept, r_value, p_value, std_err = stats.linregress(x, y)
```

## Export Results

```python
# To Excel with formatting
with pd.ExcelWriter("results.xlsx", engine="openpyxl") as writer:
    summary.to_excel(writer, sheet_name="Summary", index=False)
    df.to_excel(writer, sheet_name="Raw Data", index=False)

# To CSV
df.to_csv("output.csv", index=False)

# Save charts as images
plt.savefig("visualization.png", dpi=150, bbox_inches="tight")
```

## Best Practices
- Always use `matplotlib.use("Agg")` for non-interactive environments
- Use `plt.tight_layout()` and `bbox_inches="tight"` to prevent clipping
- Close figures after saving with `plt.close()` to free memory
- Save all output files to workspace for download
- Format numbers with appropriate precision
- Include axis labels, titles, and legends on all charts
- Use colorblind-friendly palettes when possible

## Dependencies
- `pip install pandas numpy matplotlib seaborn scipy openpyxl`
